"""
Blender Copilot Bridge Addon
Exposes a local HTTP server so the copilot-blender CLI can push Python code
into Blender and have it executed on the main thread in real-time.
"""

bl_info = {
    "name": "Copilot CLI Bridge",
    "author": "yamatsushita",
    "version": (1, 0, 0),
    "blender": (3, 0, 0),
    "location": "View3D > Sidebar > Copilot",
    "description": "Bridge between GitHub Copilot CLI and Blender 3D scene",
    "category": "Development",
}

import bpy
import threading
import json
import queue
import textwrap
from http.server import HTTPServer, BaseHTTPRequestHandler

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

_server: HTTPServer | None = None
_server_thread: threading.Thread | None = None
code_queue: queue.Queue = queue.Queue()
result_store: dict = {"last": None}   # written from main thread, read by handler


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class _CopilotHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler; all real work is deferred to the main thread."""

    def log_message(self, fmt, *args):  # silence default access log
        pass

    def _send_json(self, status: int, body: dict):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            self._send_json(200, {"status": "ok", "addon": "copilot-bridge"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/execute":
            self._send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            body = json.loads(raw)
        except Exception as e:
            self._send_json(400, {"error": f"bad request: {e}"})
            return

        code = body.get("code", "").strip()
        if not code:
            self._send_json(400, {"error": "field 'code' is required"})
            return

        # Enqueue and wait for the main thread to process it (timeout 30 s)
        evt = threading.Event()
        code_queue.put((code, evt))
        executed = evt.wait(timeout=30)

        if not executed:
            self._send_json(503, {"error": "timeout waiting for Blender main thread"})
            return

        result = result_store.get("last", {})
        status = 200 if result.get("success") else 500
        self._send_json(status, result)


# ---------------------------------------------------------------------------
# Modal operator – processes the queue inside Blender's main thread
# ---------------------------------------------------------------------------

class COPILOT_OT_RunServer(bpy.types.Operator):
    """Start / stop the Copilot HTTP bridge server"""
    bl_idname = "copilot.run_server"
    bl_label = "Run Copilot Server"

    _timer = None

    def modal(self, context, event):
        if not context.scene.copilot_server_running:
            self.cancel(context)
            return {"CANCELLED"}

        if event.type != "TIMER":
            return {"PASS_THROUGH"}

        while not code_queue.empty():
            code, evt = code_queue.get()
            try:
                # Dedent in case the user sent indented snippets
                exec(textwrap.dedent(code), {"bpy": bpy})  # noqa: S102
                result_store["last"] = {"success": True, "message": "executed"}
                # Refresh all viewports
                for window in context.window_manager.windows:
                    for area in window.screen.areas:
                        area.tag_redraw()
            except Exception as exc:
                result_store["last"] = {"success": False, "error": str(exc)}
                print(f"[Copilot Bridge] Error executing code: {exc}")
            finally:
                evt.set()

        return {"PASS_THROUGH"}

    def execute(self, context):
        wm = context.window_manager
        self._timer = wm.event_timer_add(0.05, window=context.window)
        wm.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def cancel(self, context):
        if self._timer:
            context.window_manager.event_timer_remove(self._timer)
        self._timer = None


# ---------------------------------------------------------------------------
# Start / Stop operators
# ---------------------------------------------------------------------------

class COPILOT_OT_StartServer(bpy.types.Operator):
    """Start the Copilot Bridge HTTP server"""
    bl_idname = "copilot.start_server"
    bl_label = "Start Server"

    def execute(self, context):
        global _server, _server_thread
        if context.scene.copilot_server_running:
            self.report({"WARNING"}, "Server is already running")
            return {"CANCELLED"}

        port = context.scene.copilot_server_port
        try:
            _server = HTTPServer(("127.0.0.1", port), _CopilotHandler)
            _server_thread = threading.Thread(target=_server.serve_forever, daemon=True)
            _server_thread.start()
        except OSError as e:
            self.report({"ERROR"}, f"Could not start server: {e}")
            return {"CANCELLED"}

        context.scene.copilot_server_running = True
        bpy.ops.copilot.run_server("INVOKE_DEFAULT")
        self.report({"INFO"}, f"Copilot Bridge listening on 127.0.0.1:{port}")
        return {"FINISHED"}


class COPILOT_OT_StopServer(bpy.types.Operator):
    """Stop the Copilot Bridge HTTP server"""
    bl_idname = "copilot.stop_server"
    bl_label = "Stop Server"

    def execute(self, context):
        global _server, _server_thread
        if not context.scene.copilot_server_running:
            self.report({"WARNING"}, "Server is not running")
            return {"CANCELLED"}

        context.scene.copilot_server_running = False  # signals modal to stop
        if _server:
            _server.shutdown()
            _server = None
        _server_thread = None
        self.report({"INFO"}, "Copilot Bridge stopped")
        return {"FINISHED"}


# ---------------------------------------------------------------------------
# UI Panel
# ---------------------------------------------------------------------------

class COPILOT_PT_Panel(bpy.types.Panel):
    bl_label = "Copilot CLI Bridge"
    bl_idname = "COPILOT_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Copilot"

    def draw(self, context):
        layout = self.layout
        scene = context.scene

        running = scene.copilot_server_running
        status = "🟢 Running" if running else "🔴 Stopped"

        box = layout.box()
        box.label(text=f"Status: {status}")
        box.prop(scene, "copilot_server_port", text="Port")

        row = layout.row(align=True)
        if running:
            row.operator("copilot.stop_server", text="Stop Server", icon="PAUSE")
        else:
            row.operator("copilot.start_server", text="Start Server", icon="PLAY")

        layout.separator()
        layout.label(text="Connect with CLI:", icon="CONSOLE")
        layout.label(text=f"  npx blender-copilot --port {scene.copilot_server_port}")


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

classes = (
    COPILOT_OT_RunServer,
    COPILOT_OT_StartServer,
    COPILOT_OT_StopServer,
    COPILOT_PT_Panel,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)

    bpy.types.Scene.copilot_server_running = bpy.props.BoolProperty(
        name="Server Running", default=False
    )
    bpy.types.Scene.copilot_server_port = bpy.props.IntProperty(
        name="Port", default=5123, min=1024, max=65535
    )


def unregister():
    if bpy.context.scene.get("copilot_server_running"):
        bpy.ops.copilot.stop_server()

    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)

    del bpy.types.Scene.copilot_server_running
    del bpy.types.Scene.copilot_server_port


if __name__ == "__main__":
    register()

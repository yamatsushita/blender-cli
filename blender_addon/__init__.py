"""
Blender Copilot Bridge Addon

Uses a shared directory (~/.blender-copilot/) for communication — no server,
no ports, no configuration required.

Protocol (all files live in BRIDGE_DIR):
  CLI writes  → run.py      (Python code to execute)
  CLI creates → run.trigger (content = unique request ID)
  Blender polls every 0.25 s; when trigger found:
    - deletes trigger
    - exec() the code on the main thread
    - writes result.json  {"id": <request_id>, "success": bool, "error"?: str}
"""

bl_info = {
    "name": "Copilot CLI Bridge",
    "author": "yamatsushita",
    "version": (2, 0, 0),
    "blender": (3, 0, 0),
    "location": "View3D > Sidebar > Copilot",
    "description": "Edit the Blender scene via GitHub Copilot CLI (file-based bridge)",
    "category": "Development",
}

import bpy
import json
import os
import textwrap
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Shared directory
# ---------------------------------------------------------------------------

BRIDGE_DIR = Path.home() / ".blender-copilot"
TRIGGER_FILE = BRIDGE_DIR / "run.trigger"
CODE_FILE = BRIDGE_DIR / "run.py"
RESULT_FILE = BRIDGE_DIR / "result.json"
HEARTBEAT_FILE = BRIDGE_DIR / "heartbeat"

BRIDGE_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Timer callback – runs on Blender's main thread
# ---------------------------------------------------------------------------

_timer_handle = None


def _poll_and_execute():
    """Called by Blender's app timer every 0.25 s."""
    if not TRIGGER_FILE.exists():
        return 0.25  # reschedule

    # Read request ID and code before deleting the trigger
    try:
        request_id = TRIGGER_FILE.read_text(encoding="utf-8").strip()
        code = CODE_FILE.read_text(encoding="utf-8") if CODE_FILE.exists() else ""
        TRIGGER_FILE.unlink(missing_ok=True)
    except OSError:
        return 0.25

    result: dict
    try:
        exec(textwrap.dedent(code), {"bpy": bpy})  # noqa: S102
        result = {"id": request_id, "success": True}
        # Redraw all open viewports
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                area.tag_redraw()
    except Exception as exc:
        result = {"id": request_id, "success": False, "error": str(exc)}
        print(f"[Copilot Bridge] Error: {exc}")

    RESULT_FILE.write_text(json.dumps(result), encoding="utf-8")
    return 0.25  # reschedule


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
        box = layout.box()
        box.label(text="Status: 🟢 Watching for prompts", icon="CHECKMARK")
        box.label(text=str(BRIDGE_DIR), icon="FILE_FOLDER")
        layout.separator()
        layout.label(text="Run in terminal:", icon="CONSOLE")
        layout.label(text="  blender-copilot")


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

classes = (COPILOT_PT_Panel,)


def register():
    global _timer_handle
    for cls in classes:
        bpy.utils.register_class(cls)
    _timer_handle = bpy.app.timers.register(_poll_and_execute, persistent=True)
    print(f"[Copilot Bridge] Watching {BRIDGE_DIR}")


def unregister():
    global _timer_handle
    if _timer_handle is not None and bpy.app.timers.is_registered(_poll_and_execute):
        bpy.app.timers.unregister(_poll_and_execute)
    _timer_handle = None
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()

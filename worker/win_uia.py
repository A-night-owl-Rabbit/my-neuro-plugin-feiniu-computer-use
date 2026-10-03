# -*- coding: utf-8 -*-
"""UI Automation: indexed element tree, focus / selection / document text, element clicks
and direct value setting. Degrades gracefully when `uiautomation` is unavailable."""
import sys
import time

_saved_stdout = sys.stdout
try:
    # uiautomation may print to stdout while importing; keep the JSON channel clean.
    sys.stdout = sys.stderr
    import uiautomation as auto
    UIA_AVAILABLE = True
    UIA_ERROR = ""
except Exception as exc:  # pragma: no cover - depends on the environment
    auto = None
    UIA_AVAILABLE = False
    UIA_ERROR = str(exc)
finally:
    sys.stdout = _saved_stdout

EDITABLE_TYPES = {"EditControl", "DocumentControl", "ComboBoxControl"}
TEXT_TYPES = {"EditControl", "DocumentControl", "TextControl"}
# Types that may expose a writable ValuePattern but are not text input surfaces.
NEVER_EDITABLE_TYPES = {
    "TitleBarControl", "MenuBarControl", "MenuItemControl", "ScrollBarControl", "StatusBarControl",
    "WindowControl", "ButtonControl", "CheckBoxControl", "RadioButtonControl", "TabControl",
    "TabItemControl", "ToolBarControl", "ImageControl", "SliderControl", "ProgressBarControl",
    "HyperlinkControl", "ListControl", "TreeControl", "HeaderControl", "HeaderItemControl",
}

_last_tree = {"hwnd": None, "controls": [], "elements": [], "created": 0.0}


class UiaError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require():
    if not UIA_AVAILABLE:
        raise UiaError("uia_unavailable", f"uiautomation 不可用: {UIA_ERROR or '未安装'}")


def _rect_dict(rect):
    return {"left": int(rect.left), "top": int(rect.top), "right": int(rect.right), "bottom": int(rect.bottom)}


def _safe(getter, default=None):
    try:
        return getter()
    except Exception:
        return default


def _pattern_available(control, prop_name):
    prop = getattr(auto.PropertyId, prop_name, None)
    if prop is None:
        return False
    return bool(_safe(lambda: control.GetPropertyValue(prop), False))


def _patterns(control):
    found = []
    for name, prop in (
        ("invoke", "IsInvokePatternAvailableProperty"),
        ("value", "IsValuePatternAvailableProperty"),
        ("toggle", "IsTogglePatternAvailableProperty"),
        ("select", "IsSelectionItemPatternAvailableProperty"),
        ("expand", "IsExpandCollapsePatternAvailableProperty"),
        ("text", "IsTextPatternAvailableProperty"),
        ("scroll", "IsScrollPatternAvailableProperty"),
    ):
        if _pattern_available(control, prop):
            found.append(name)
    return found


def _is_editable(control, control_type, patterns):
    if control_type in NEVER_EDITABLE_TYPES:
        return False
    if control_type in EDITABLE_TYPES:
        if "value" in patterns:
            vp = _safe(lambda: control.GetPattern(auto.PatternId.ValuePattern))
            if vp is not None and _safe(lambda: vp.IsReadOnly, False):
                return False
        return True
    if "value" in patterns and control_type in ("CustomControl", "TextControl", "DataItemControl", "SpinnerControl"):
        vp = _safe(lambda: control.GetPattern(auto.PatternId.ValuePattern))
        return vp is not None and not _safe(lambda: vp.IsReadOnly, True)
    return False


def _value_text(control, max_chars):
    vp = _safe(lambda: control.GetPattern(auto.PatternId.ValuePattern))
    if vp is not None:
        value = _safe(lambda: vp.Value, None)
        if value:
            return str(value)[:max_chars]
    tp = _safe(lambda: control.GetPattern(auto.PatternId.TextPattern))
    if tp is not None:
        doc = _safe(lambda: tp.DocumentRange, None)
        if doc is not None:
            text = _safe(lambda: doc.GetText(max_chars), None)
            if text:
                return str(text)
    return ""


def _selected_text(control, max_chars):
    tp = _safe(lambda: control.GetPattern(auto.PatternId.TextPattern))
    if tp is None:
        return ""
    ranges = _safe(lambda: tp.GetSelection(), None) or []
    parts = []
    for rng in ranges:
        text = _safe(lambda: rng.GetText(max_chars), None)
        if text:
            parts.append(str(text))
    return "\n".join(parts)[:max_chars]


def describe_control(control, max_value_chars=120):
    control_type = _safe(lambda: control.ControlTypeName, "Unknown") or "Unknown"
    name = _safe(lambda: control.Name, "") or ""
    rect = _safe(lambda: control.BoundingRectangle, None)
    patterns = _patterns(control)
    info = {
        "type": control_type,
        "name": str(name)[:200],
        "rect": _rect_dict(rect) if rect is not None else None,
        "patterns": patterns,
        "editable": _is_editable(control, control_type, patterns),
        "enabled": bool(_safe(lambda: control.IsEnabled, True)),
        "focused": bool(_safe(lambda: control.HasKeyboardFocus, False)),
    }
    if info["editable"] or control_type in TEXT_TYPES:
        value = _value_text(control, max_value_chars)
        if value:
            info["value"] = value
    return info


def ui_tree(hwnd, depth=3, max_children=25, max_elements=150, time_budget_ms=4000, doc_max_chars=2000):
    """Depth-first indexed tree of the visible elements of a window."""
    _require()
    hwnd = int(hwnd)
    root = _safe(lambda: auto.ControlFromHandle(hwnd))
    if root is None:
        raise UiaError("not_found", "无法从窗口句柄获取 UI 根元素")

    deadline = time.monotonic() + max(time_budget_ms, 500) / 1000.0
    elements = []
    controls = []
    state = {"truncated": False}

    def walk(control, level):
        if len(elements) >= max_elements or time.monotonic() > deadline:
            state["truncated"] = True
            return
        if level > 0:
            if _safe(lambda: control.IsOffscreen, False):
                return
            rect = _safe(lambda: control.BoundingRectangle, None)
            if rect is None or rect.width() <= 0 or rect.height() <= 0:
                return
        info = describe_control(control)
        info["index"] = len(elements)
        info["depth"] = level
        elements.append(info)
        controls.append(control)
        if level >= depth:
            return
        children = _safe(lambda: control.GetChildren(), None) or []
        for child in children[:max_children]:
            walk(child, level + 1)
            if state["truncated"]:
                return
        if len(children) > max_children:
            state["truncated"] = True

    walk(root, 0)

    _last_tree.update({"hwnd": hwnd, "controls": controls, "elements": elements, "created": time.time()})

    focused = None
    focused_control = _safe(lambda: auto.GetFocusedControl())
    if focused_control is not None:
        focused = describe_control(focused_control, max_value_chars=doc_max_chars)
        focused["index"] = None
        focused_rid = _safe(lambda: tuple(focused_control.GetRuntimeId()), None)
        for idx, ctrl in enumerate(controls):
            if focused_rid is None:
                break
            same_id = _safe(lambda: tuple(ctrl.GetRuntimeId()), None) == focused_rid
            same_shape = elements[idx]["type"] == focused["type"] and elements[idx]["rect"] == focused["rect"]
            if same_id and same_shape:
                focused["index"] = idx
                break
        if focused["index"] is None:
            for el in elements:
                if el.get("focused"):
                    focused["index"] = el["index"]
                    break

    document_text = ""
    if focused_control is not None:
        document_text = _value_text(focused_control, doc_max_chars)
    if not document_text:
        for idx, el in enumerate(elements):
            if el["type"] in ("DocumentControl", "EditControl"):
                document_text = _value_text(controls[idx], doc_max_chars)
                if document_text:
                    break

    selected_text = _selected_text(focused_control, 1000) if focused_control is not None else ""

    return {
        "hwnd": hwnd,
        "window_title": _safe(lambda: root.Name, "") or "",
        "elements": elements,
        "element_count": len(elements),
        "truncated": state["truncated"],
        "focused_element": focused,
        "document_text": document_text,
        "selected_text": selected_text,
    }


def element_rect(hwnd, index):
    """Physical rect of an element from the most recent tree of the same window."""
    hwnd = int(hwnd)
    if _last_tree["hwnd"] != hwnd:
        raise UiaError("stale_index", "元素编号来自另一个窗口的观察，请重新观察")
    try:
        index = int(index)
        element = _last_tree["elements"][index]
        control = _last_tree["controls"][index]
    except (IndexError, ValueError, TypeError):
        raise UiaError("stale_index", f"元素编号 {index} 不存在于最近一次观察")
    rect = _safe(lambda: control.BoundingRectangle, None)
    if rect is None or rect.width() <= 0 or rect.height() <= 0:
        rect_dict = element.get("rect")
        if not rect_dict:
            raise UiaError("no_rect", "该元素当前没有可点击区域")
        return element, rect_dict
    return element, _rect_dict(rect)


def set_value(hwnd, index, value):
    _require()
    element, _ = element_rect(hwnd, index)
    control = _last_tree["controls"][int(index)]
    vp = _safe(lambda: control.GetPattern(auto.PatternId.ValuePattern))
    if vp is None:
        raise UiaError("no_value_pattern", "该元素不支持直接赋值，请改用点击后输入")
    if _safe(lambda: vp.IsReadOnly, False):
        raise UiaError("read_only", "该元素是只读的")
    vp.SetValue(str(value))
    time.sleep(0.05)
    return {"index": int(index), "name": element.get("name", ""), "value": _safe(lambda: vp.Value, "")}


def focused_summary(doc_max_chars=2000):
    _require()
    control = _safe(lambda: auto.GetFocusedControl())
    if control is None:
        return None
    info = describe_control(control, max_value_chars=doc_max_chars)
    info["hwnd"] = int(_safe(lambda: control.NativeWindowHandle, 0) or 0)
    return info

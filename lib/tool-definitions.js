'use strict';

const OBS = {
    type: 'string',
    description: '最近一次 computer_observe（或动作自动返回的观察）给出的 observation_id。只有最新的、且之后没做过动作的观察才有效。'
};
const OBSERVE_AFTER = {
    type: 'boolean',
    description: '动作完成后是否自动重新观察并返回新截图（默认 true）。连续按几个键时可以设为 false，但下一次带坐标或编号的动作前必须重新观察。'
};

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'computer_list_windows',
            description: '列出当前桌面上可以操作的窗口（编号 window_id、标题、进程名、位置、是否前台，以及每个窗口的操作分级）。开始一项桌面任务时先用它找到唯一的目标窗口。',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: '可选。按标题或进程名关键词过滤，例如 "记事本" 或 "notepad"。' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_launch_app',
            description: '启动一个桌面应用并等待它的窗口出现，返回该窗口信息。支持常用别名（记事本、画图、计算器、资源管理器…）、开始菜单里的程序名或 .exe 绝对路径。不能用来运行命令行。',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string', description: '应用名、开始菜单名或 .exe 绝对路径。' },
                    wait_ms: { type: 'integer', description: '最多等待窗口出现的毫秒数，默认 6000。' }
                },
                required: ['target']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_observe',
            description: '观察一个窗口：把它切到前台，截图给你看，并返回 observation_id、窗口信息、截图尺寸、焦点元素、选中文本、文档文本；include_ui_tree=true 时还返回带编号的界面元素树（可按编号点击，比坐标更准）。任何点击/输入前都要先有一次新观察。',
            parameters: {
                type: 'object',
                properties: {
                    window_id: { type: 'integer', description: '目标窗口编号（来自 computer_list_windows / computer_launch_app）。不填则沿用上次目标，再没有就用当前前台窗口。' },
                    include_screenshot: { type: 'boolean', description: '是否截图，默认 true。只想读文字和元素树时设为 false 更省 token。' },
                    include_ui_tree: { type: 'boolean', description: '是否返回带编号的界面元素树，默认 false。需要按编号点击、读取输入框内容、确认焦点时设为 true。' },
                    tree_depth: { type: 'integer', description: '元素树深度，默认 3，复杂界面可用 4～5。' },
                    scope: { type: 'string', enum: ['window', 'screen'], description: '截图范围：window 只截目标窗口（默认，坐标更精确）；screen 截整个显示器（找桌面图标、任务栏外的东西时用）。' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_click',
            description: '在目标窗口里点击。优先用 element_index（来自最新观察的元素树）；没有元素树时用截图上的像素坐标 x,y。默认动作后自动重新观察并返回新截图。',
            parameters: {
                type: 'object',
                properties: {
                    observation_id: OBS,
                    element_index: { type: 'integer', description: '要点击的元素编号（推荐）。' },
                    x: { type: 'number', description: '截图像素 X 坐标（没有 element_index 时必填）。' },
                    y: { type: 'number', description: '截图像素 Y 坐标（没有 element_index 时必填）。' },
                    button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键，默认 left。' },
                    count: { type: 'integer', description: '点击次数：1 单击（默认）、2 双击、3 三击。' },
                    observe_after: OBSERVE_AFTER
                },
                required: ['observation_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_type',
            description: '往当前键盘焦点输入文字（支持中文）。前提：最新观察显示焦点在可编辑控件上（或主人明确要求在该应用里打字）。换行请用 computer_press_key enter，不要把换行塞进文本。',
            parameters: {
                type: 'object',
                properties: {
                    observation_id: OBS,
                    text: { type: 'string', description: '要输入的文字。' },
                    observe_after: OBSERVE_AFTER
                },
                required: ['observation_id', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_press_key',
            description: '按一个键或组合键，例如 enter、tab、esc、ctrl+s、ctrl+shift+t、alt+tab、f5、down。禁止 Win 键。关闭窗口类组合键（alt+f4、ctrl+w）会先请主人确认。',
            parameters: {
                type: 'object',
                properties: {
                    observation_id: OBS,
                    key: { type: 'string', description: '按键或用 + 连接的组合键。' },
                    repeat: { type: 'integer', description: '重复次数，默认 1，最多 20。' },
                    observe_after: OBSERVE_AFTER
                },
                required: ['observation_id', 'key']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_scroll',
            description: '在截图上的某个位置滚动鼠标滚轮。delta_y 正数向下、负数向上，单位是"格"（1 格约 3 行）。',
            parameters: {
                type: 'object',
                properties: {
                    observation_id: OBS,
                    x: { type: 'number', description: '截图像素 X。' },
                    y: { type: 'number', description: '截图像素 Y。' },
                    delta_y: { type: 'integer', description: '垂直滚动格数，正数向下。' },
                    delta_x: { type: 'integer', description: '水平滚动格数，正数向右，默认 0。' },
                    observe_after: OBSERVE_AFTER
                },
                required: ['observation_id', 'x', 'y', 'delta_y']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_drag',
            description: '按住鼠标左键从一点拖到另一点（画线、拖动文件、拖动滑块、框选）。坐标都是截图像素。',
            parameters: {
                type: 'object',
                properties: {
                    observation_id: OBS,
                    from_x: { type: 'number' }, from_y: { type: 'number' },
                    to_x: { type: 'number' }, to_y: { type: 'number' },
                    duration_ms: { type: 'integer', description: '拖动耗时毫秒，默认 500。' },
                    observe_after: OBSERVE_AFTER
                },
                required: ['observation_id', 'from_x', 'from_y', 'to_x', 'to_y']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_set_value',
            description: '直接把一个可编辑元素（输入框、地址栏、下拉框）的内容整体替换成 value，不模拟逐字打字。需要最新观察带元素树，且该元素标记为可编辑。',
            parameters: {
                type: 'object',
                properties: {
                    observation_id: OBS,
                    element_index: { type: 'integer', description: '元素编号。' },
                    value: { type: 'string', description: '新的内容。' },
                    observe_after: OBSERVE_AFTER
                },
                required: ['observation_id', 'element_index', 'value']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_confirm_action',
            description: '主人明确同意后，执行之前返回的待确认电脑动作。没有主人的明确同意不要调用。',
            parameters: {
                type: 'object',
                properties: {
                    pending_action_id: { type: 'string', description: '待确认动作 ID。' },
                    remember_app: { type: 'boolean', description: '主人说"以后这个软件都可以"时设为 true，本次会话内不再询问该应用。' }
                },
                required: ['pending_action_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_cancel_action',
            description: '取消待确认的电脑动作。主人拒绝、犹豫或改变主意时调用；不填 ID 则取消全部。',
            parameters: {
                type: 'object',
                properties: {
                    pending_action_id: { type: 'string', description: '要取消的待确认动作 ID，可不填。' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_stop',
            description: '立刻停止电脑操作：作废当前观察和所有待确认动作，本回合不再执行任何桌面动作。主人说"停""别动了"或你发现情况不对时调用。',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: '停止原因，可不填。' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'computer_doctor',
            description: '诊断电脑操作能力：worker 是否正常、Python 路径、依赖、显示器与 DPI、截图排除设置、当前策略与本回合状态。工具报错或主人问"你能不能操作电脑"时用。',
            parameters: { type: 'object', properties: {} }
        }
    }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name));

function getTools({ autonomousControl = false } = {}) {
    if (!autonomousControl) return TOOLS;
    return TOOLS.filter(tool => !['computer_confirm_action', 'computer_cancel_action'].includes(tool.function.name))
        .map(tool => {
            if (tool.function.name !== 'computer_press_key') return tool;
            return { ...tool, function: { ...tool.function,
                description: '按一个键或组合键，例如 enter、tab、esc、ctrl+s、alt+f4、win、win+r、win+e、ctrl+shift+esc。已获自主操作授权，无需逐次确认。Ctrl+Alt+Delete 无法通过此输入接口模拟。'
            } };
        });
}

module.exports = { TOOLS, TOOL_NAMES, getTools };

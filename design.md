# Design — Texas Hold'em Arena

这是本项目锁定的视觉系统。所有公开页、赛程回放与管理页在修改前都必须读取本文件；不要为单个页面重新选择主题或字体。

## Genre

modern-minimal，偏实用工具。专注、清晰、稳重，保留真实牌桌的材质感，不采用 AI 产品官网常见的装饰性排版。

## Audience and primary jobs

- 观众：快速看清牌局、筹码、底池、行动和结果。
- 赛事管理员：配置模型与 API、创建赛事、处理赛事状态。
- 复盘者：按手读取完整事件、公共牌、赛后底牌与公平性信息。

## Macrostructure family

- 公开直播页：Workbench。牌桌和事件记录是主内容，标题保持功能性。
- 公开档案、榜单、回放：Index-First。列表和逐手导航直接承担页面结构。
- 管理端：Workbench。左侧工作导航、右侧高密度操作区；不使用营销式 Hero。
- 登录页：克制的 Split Studio，只保留安全说明与表单两块。

## Navigation and footer

- 公开页：N9 Edge-aligned minimal 的实用变体。品牌、三个公开入口、一个管理入口；手机端保持一行并缩短标签。
- 管理端：N3 Side-rail 的产品变体。桌面固定左栏，窄屏转为顶部横向工作导航，不旋转文字。
- 页脚：Ft2 Inline rule single line。只说明产品性质与可验证性，不展示虚构站点地图。

## Theme

- 深色底面：`--color-paper` = `oklch(14.5% 0.018 155)`。
- 浅色底面：暖象牙纸面与暖白浮层，分隔线使用低彩度暖灰；不得将浅绿灰作为中性色铺满页面。
- 浮层递进：`--color-paper-2`、`--color-paper-3`、`--color-surface-raised` 每级提高亮度。
- 正文：`--color-ink`；次级正文不得低于 `--color-muted`。
- 唯一品牌强调：`--color-accent` = `oklch(75% 0.11 78)`，旧黄铜。
- 黄铜文字在深毡绿上必须使用 `--color-accent-on-dark`，不得复用浅色纸面上的深黄铜文字色。
- 牌桌：`--color-felt` 系列；只用于牌桌和少量牌局状态。
- 浅色模式中的图表使用暖白绘图区；深绿背景只承载牌桌、公共牌面等明确牌局语义，并使用专门的高对比前景色。
- 状态色只用于成功、警告、危险，不作为大面积装饰。
- 所有颜色声明均来自 `tokens.css`，组件内不得出现临时 hex、rgb、hsl 或 OKLCH。

## Typography

- Display：Manrope，700，normal。
- Body：Manrope，400–600，默认 16px，行高 1.6。
- Mono：Azeret Mono，400–500，仅用于 ID、筹码、牌局编号、API/JSON/SSE 和技术数据，最小 12px。
- Card：Cormorant Garamond，600，仅用于扑克牌字面与品牌牌面标记；不得用于斜体标题。
- 标题必须为正常体，不使用斜体强调词。
- 页面最多出现五档字号；正文最小 14px，默认 16px；表格与导航最小 14px。
- 数字表格统一使用 tabular figures。

## Copy

- 中文优先。保留 API、JSON、SSE、Provider、模型 ID、System Prompt 等必要技术词。
- 删除装饰性英文眉题、英文全大写章节名、无意义编号和重复的中英双标题。
- 状态文案必须说明发生了什么；错误信息要给出下一步。
- 操作按钮使用明确动词，例如“新增模型”“保存连接”“打开回放”。
- 可点击文案始终单行，不用长句充当按钮。

## Spacing and layout

- 使用 `tokens.css` 的 4pt 命名间距；组件样式不得临时写间距常量。
- 公开页内容最大宽度 `--content-max`，在超宽屏保持居中且提高信息密度。
- 工作区强调清晰表面层级，不使用卡片套卡片。
- 默认圆角 8px，牌桌本身除外。
- `html` 与 `body` 均使用 `overflow-x: clip`。
- 320、375、414、768px 必须无页面级横向滚动；宽表格在手机端改为分组行，不靠整页横向滚动。

## Motion

- 不使用整页入场、逐区滚动 reveal、视差或装饰性循环。
- 允许：按钮按压、弹窗淡入、菜单状态、加载指示、直播连接状态。
- 仅动画 `transform` 与 `opacity`；焦点环即时显示。
- `prefers-reduced-motion: reduce` 下空间运动缩减为不超过 150ms 的透明度变化。

## Interaction and states

- 所有可交互元素至少有 default、hover、focus-visible、active、disabled、loading、error、success 对应样式或语义状态。
- 输入框和按钮高度统一为 44–48px；触控目标不小于 44×44px。
- 输入框边框宽度在所有状态保持 1px，焦点用 outline，不造成布局跳动。
- 表单标签始终可见；placeholder 只展示格式示例。
- 成功优先静默反映在界面；错误使用清晰通知并保留重试入口。

## Per-page allowances

- 直播页可以使用牌桌材质和轻量环境层次；其他页面不得复制牌桌装饰。
- 回放页可以展示横向逐手选择器，但页面根节点不能横向滚动。
- 管理端不使用插画、巨型字母、水印、噪点或装饰性背景图。
- 牌局、手数、盲注级别等真实顺序信息可以编号；章节标题不得用编号装饰。

## What pages MUST share

- 品牌标记、深毡绿与旧黄铜配色。
- Manrope、Azeret Mono、Cormorant Garamond 的固定职责。
- 8px 内圆角、44px 控件高度、可见焦点环。
- 中文优先的控件与状态文案。
- 公开页头、管理工作导航和单行页脚的结构。

## Exports

### tokens.css

项目根目录的 `tokens.css` 是完整、可执行的源文件。下列格式与该文件保持同一语义映射。

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(14.5% 0.018 155);
  --color-paper-2: oklch(18.5% 0.022 155);
  --color-paper-3: oklch(22.5% 0.025 155);
  --color-ink: oklch(94% 0.012 88);
  --color-ink-2: oklch(82% 0.014 92);
  --color-muted: oklch(72% 0.014 150);
  --color-rule: oklch(35% 0.025 155);
  --color-accent: oklch(75% 0.11 78);
  --color-focus: oklch(82% 0.15 82);
  --font-display: "Manrope", sans-serif;
  --font-body: "Manrope", sans-serif;
  --font-mono: "Azeret Mono", monospace;
  --font-card: "Cormorant Garamond", serif;
  --spacing-3xs: 0.25rem;
  --spacing-2xs: 0.5rem;
  --spacing-xs: 0.75rem;
  --spacing-sm: 1rem;
  --spacing-md: 1.5rem;
  --spacing-lg: 2rem;
  --spacing-xl: 3rem;
  --spacing-2xl: 4.5rem;
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-md: 1.125rem;
  --text-lg: 1.375rem;
  --text-xl: 1.75rem;
  --text-2xl: 2.25rem;
  --radius-card: 0.5rem;
  --radius-input: 0.5rem;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
}
```

### DTCG `tokens.json`

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(14.5% 0.018 155)", "$type": "color" },
    "paper-2": { "$value": "oklch(18.5% 0.022 155)", "$type": "color" },
    "paper-3": { "$value": "oklch(22.5% 0.025 155)", "$type": "color" },
    "ink": { "$value": "oklch(94% 0.012 88)", "$type": "color" },
    "ink-2": { "$value": "oklch(82% 0.014 92)", "$type": "color" },
    "muted": { "$value": "oklch(72% 0.014 150)", "$type": "color" },
    "rule": { "$value": "oklch(35% 0.025 155)", "$type": "color" },
    "accent": { "$value": "oklch(75% 0.11 78)", "$type": "color" },
    "focus": { "$value": "oklch(82% 0.15 82)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Manrope, sans-serif", "$type": "fontFamily" },
    "body": { "$value": "Manrope, sans-serif", "$type": "fontFamily" },
    "mono": { "$value": "Azeret Mono, monospace", "$type": "fontFamily" },
    "card": { "$value": "Cormorant Garamond, serif", "$type": "fontFamily" }
  },
  "space": {
    "xs": { "$value": "0.75rem", "$type": "dimension" },
    "sm": { "$value": "1rem", "$type": "dimension" },
    "md": { "$value": "1.5rem", "$type": "dimension" },
    "lg": { "$value": "2rem", "$type": "dimension" }
  },
  "duration": {
    "micro": { "$value": "100ms", "$type": "duration" },
    "short": { "$value": "180ms", "$type": "duration" },
    "long": { "$value": "280ms", "$type": "duration" }
  }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: 14.5% 0.018 155;
  --foreground: 94% 0.012 88;
  --card: 18.5% 0.022 155;
  --card-foreground: 94% 0.012 88;
  --popover: 22.5% 0.025 155;
  --popover-foreground: 94% 0.012 88;
  --primary: 75% 0.11 78;
  --primary-foreground: 19% 0.025 155;
  --secondary: 22.5% 0.025 155;
  --secondary-foreground: 82% 0.014 92;
  --muted: 29% 0.023 155;
  --muted-foreground: 72% 0.014 150;
  --accent: 75% 0.11 78;
  --accent-foreground: 19% 0.025 155;
  --destructive: 66% 0.15 28;
  --destructive-foreground: 19% 0.025 155;
  --border: 35% 0.025 155;
  --input: 35% 0.025 155;
  --ring: 82% 0.15 82;
  --radius: 0.5rem;
}
```

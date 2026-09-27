# OpenNovelWriter 提示词宏

本参考以运行时模板渲染器为准。模板使用 Nunjucks，关闭自动转义。创建或编辑提示词时只使用这里列出的上下文，不要假设酒馆宏或其他模板变量存在。

## 基础语法

```nunjucks
{{ value }}
{% if value %}...{% endif %}
{% set terms = instruction.terms | union(inputs["额外信息"].term) %}
{% include "组件名" %}
{# 注释不会进入渲染结果 #}
```

`{{ ... }}` 输出表达式，`{% ... %}` 是控制语句，`{# ... #}` 是注释。`{%-`、`-%}` 可裁掉标签相邻的空白。include 按组件名称匹配，不区分大小写，最大嵌套深度为 5；缺失、循环或超深都会产生警告。`union` 只合并词条集合并去重，不是通用字符串或数组函数。

同一次渲染中的消息按顺序处理，原生 `{% set %}` 定义的变量可在该次渲染的后续消息中读取；变量不跨渲染保存。AI 聊天的后续轮次只渲染最后一条 user 模板，每轮需要的变量应在该消息或其引用组件中定义，不要依赖前置 system 消息中的 `{% set %}`。

```nunjucks
{% set wordsCloud = "不少于1000" %}
{{ wordsCloud }}
{{ ["a", "b", "c"] | random }}
{{ wordsCloud | trim }}
{{ roll("1d6") }}
```

`random` 与 `trim` 是 Nunjucks 原生 filter。`roll("NdM")` 是 ONW 提供的骰子函数，输出 `N` 个 `1..M` 随机点数之和；格式非法会输出空字符串。

`termsfrom(...)` 从传入内容中按词条名称和别名识别词条，返回支持 `.ids`、`.count`、`.text`、`.value` 和 `union` 的去重集合。支持文本、输入项、正文或摘要集合、多个参数和列表；对象会展开为实际内容，按所选的全文/摘要配置检测。只检测传入内容，再统一加入始终包含的词条、排除永不包含及已归档词条；空参数或空内容也会返回始终包含的词条。

```nunjucks
{% set terms = termsfrom(scene.text, inputs["额外信息"].chapter, inputs["额外信息"].snippet) %}
{{ terms.value }}
{% set terms = termsfrom([novel.outline.full, inputs["写作要求"].value]) %}
{% set detailText %}{% include "DetailedOutline" %}{% endset %}
{{ termsfrom(detailText).value }}
```

参数先按 Nunjucks 表达式求值，也可以传入 `{% set %}...{% endset %}` 捕获的组件渲染结果。字符串内容不会被再次当作模板执行。

AI 聊天中，传入 `inputs["额外信息"].chapterOutline` 等正文或细纲子集合，仍能从原始所选内容中识别词条，即使正文因已发送而被省略。传入 `.value` 或捕获的组件输出时，只检测得到的字符串，该字符串可能已经因去重而为空。识别出的词条也遵循聊天的整项去重规则。

`DetailedOutline`、`AdditionalInfo`、`TermKnowledge` 等是内置组件名，不是额外的全局变量。需要从细纲提取词条时，显式调用 `termsfrom(scene.actOutline, scene.chapterOutline)`，或捕获组件输出后再检测。

### 空白控制

全局 `trimBlocks` 和 `lstripBlocks` 均未开启，模板不会自动压缩空白行。`{%-` 删除标签前相邻的空白，`-%}` 删除标签后相邻的空白，范围包括换行。

单独占行的变量声明会留下换行。变量本身不需要输出文本时，使用两侧空白控制，避免预览和最终提示词出现成片空行：

```nunjucks
{%- set harukiCoreStatement = "" -%}
{%- set cotBegin = "我们来看看用户的任务" -%}
```

不要为保留 Tavern 的空变量而输出一个空白字符；空值用 `""`。只有源值本身的首尾空白有语义时才保留它，并避免使用会改变该值的 `trim` filter。

`{%- include "AdditionalInfo" %}` 可以清理 include 前的空白，但组件自身仍需保留与前文的分隔。不要给所有 include 统一加上两侧减号，以免把相邻正文或标签粘在一起。可选组件可采用下面的结构，空值时不输出空行，非空时保留段落边界：

```nunjucks
{%- if inputs["额外信息"].chapter.value %}

<AdditionalInfo>
{{ inputs["额外信息"].chapter.value }}
</AdditionalInfo>
{%- endif %}
```

## 小说上下文

| 宏 | 内容 |
| --- | --- |
| `{{ novel.language }}` | 当前小说语言 |
| `{{ novel.outline }}` | 当前执行点之前的故事摘要，等同于 `storysofar` |
| `{{ novel.outline.storysofar }}` | 当前执行点之前的故事摘要 |
| `{{ novel.outline.full }}` | 全书所有非空卷摘要和场景摘要 |

## 场景与指令

| 宏 | 内容 |
| --- | --- |
| `{{ scene.text }}` | 当前场景完整正文，主要用于 `scene_action` |
| `{{ scene.previousText }}` | 续写位置之前的正文 |
| `{{ scene.followText }}` | 续写位置之后的正文 |
| `scene.hasPreviousText` / `scene.hasFollowText` | 对应正文是否非空 |
| `{{ scene.chapterOutline }}` | 当前章的章纲 |
| `{{ scene.actOutline }}` | 当前卷的卷纲 |
| `scene.hasChapterOutline` / `scene.hasActOutline` | 对应细纲是否非空 |
| `{{ instruction.text }}` | 场景续写时作者给出的当前指令 |
| `instruction.terms` | 当前指令提及和始终包含的词条集合 |

词条集合提供 `.count`、`.text`、`.value`：`.text` 是词条名称/简要表示，`.value` 是完整词条块。通常注入知识时使用 `.value`。

```nunjucks
{% set outlineTerms = termsfrom(scene.actOutline, scene.chapterOutline, inputs["额外信息"].actOutline, inputs["额外信息"].chapterOutline) %}
{% set terms = instruction.terms | union(inputs["额外信息"].term) | union(inputs["额外信息"].termTag) | union(outlineTerms) %}
{% if terms.count %}
<TermKnowledge>
{{ terms.value }}
</TermKnowledge>
{% endif %}
```

## AI 聊天

| 宏 | 内容 |
| --- | --- |
| `{{ chat.userInput }}` | 当前一轮用户输入 |
| `chat.userInput.terms` | 当前输入提及和始终包含的词条集合 |
| `{{ chat.history }}` | 当前会话用户与助手的消息正文合并文本，不包含附加资料的完整发送文本 |
| `chat.history.terms` | 聊天入口提供的词条集合；普通 AI 聊天当前仅提供“始终包含”词条 |

AI 聊天入口的最后一条消息必须是 user，并且整份提示词中只能在该消息里出现一次裸 `{{ chat.userInput }}`。需要知识时可合并 `chat.userInput.terms` 和内容选择词条；需要从历史正文提取词条时显式调用 `termsfrom(chat.history)`。

首次发送时固定提示词、引用组件和已渲染的前置消息；后续只重新渲染最后一条 user 模板。会话历史自动以原有 user/assistant 消息加入请求，不会再次作为模板执行。每轮变化的资料和输入应放在最后一条 user 模板中，通常不必再输出 `{{ chat.history }}`，以免重复附加历史。

聊天会按资料身份及完整内容去重：已发送且未变化的词条、内容选择子集合和小说摘要不再重复输出；内容改变后完整重发。本轮用户输入保持完整，不参与资料去重。子集合的 `.count`、`.text`、`.value` 反映本轮剩余内容，应据此判断是否输出包裹标签。

需要整项去重时，读取 `.chapter.value`、`.snippet.value`、`.term.value` 等子集合。直接输出整个 `inputs["额外信息"].value` 不经过这些子集合的去重，不要将它视为等价写法。

## 输入

所有输入都通过 `inputs["输入名"]` 读取。输入可定义在入口提示词或递归 include 的组件中，面板和虚拟续写都会继承组件输入，无需在入口重复定义。同名输入以入口定义优先；组件之间按递归引用顺序取第一个，名称匹配忽略首尾空格和大小写。

必填校验只检查入口模板或其 include 组件引用的输入；未引用的输入不会报缺失。

### Custom 和 checkbox

`{{ inputs["名称"].value }}` 与 `.text` 都是最终字符串：dropdown 选项优先使用选项 `content`，为空时使用 `label`；多选和自由文本以空行连接。checkbox 开启时值为 `displayName`（为空则为输入名），关闭时为空字符串。条件判断直接使用该值：

```nunjucks
{% if inputs["启用planning"].value %}...{% endif %}
```

dropdown 的每个选项应把真正送给模型的完整提示词放进 `content`。无论单选还是多选，模板通常只需直接输出一次 `.value`；多选值会按选择顺序以空行拼接，不要为每个候选生成一组 `if`：

```nunjucks
{{ inputs["文风"].value }}
```

`export_prompt` 保留输入配置、选项的 `id`、`label`、`content` 及默认选项 ID。调用 `compose_scene_continuation` 时，自定义输入按名称传 `{ "dropdownOptionIds": ["选项ID"], "text": "自由文本" }`，后端按面板规则展开。只能使用启用的方式；单选下拉与自由文本二选一，多选允许组合。省略整个输入沿用默认值，传入对象则替换该输入，未填字段为空，`{}` 清空。checkbox 传布尔值，`false` 取消勾选；必填 checkbox 必须勾选。

只有输出结构确实取决于是否包含某个值时才做成员判断。Nunjucks 使用 `in`，不支持 `contains` 或 JavaScript 的 `includes`：

```nunjucks
{% if "腿部" in inputs["部位符号"].value %}...{% endif %}
```

不要使用本参考未列出的语言方法或运算符。生成 change-set 后必须先通过工具的模板语法校验。

### 内容选择

每个子集合都有 `.count`、`.text`、`.value`：

| 子集合 | 内容 |
| --- | --- |
| `term` | 作者选择的词条 |
| `termTag` | 由所选词条标记展开的词条 |
| `snippet` | 作者片段 |
| `fullNovel` | 全书选择 |
| `act` | 直接选择的卷，以及标签关联的卷 |
| `chapter` | 章选择 |
| `scene` | 直接选择的场景，以及标签关联的场景 |
| `actOutline` | 卷纲选择 |
| `chapterOutline` | 章纲选择 |

`.text` 通常是标题或简短表示，`.value` 是按输入配置的全文或摘要。直接读取 `inputs["额外信息"].value` 会把所有所选内容合并；精细拼装时读取子集合。

“标签”关联的卷和场景分别展开到 `.act`、`.scene`，没有单独的 `.label` 集合。它们使用标签选项各自的卷/场景全文或摘要设置；同一对象同时被直接选中时，以直接选择的设置为准。“词条标记”则展开到 `.termTag`，两者不同。

新建内容选择输入时，界面默认允许全部内容类型，不代表自动选入全部资料。作者选择的内容只有被模板引用才会输出；需要补充正文或摘要时，可引用内置 `AdditionalInfo` 组件，或自行读取相应子集合。

虚拟续写会在每个内容选择输入内按类型和标识去重，保留首次出现的顺序，再进行单选限制检查和内容展开。不同输入之间不互相去重。

## 类别边界

- `scene_continuation`：优先使用 `instruction.*`、`scene.previousText/followText`、细纲和 outline。
- `scene_action`：优先使用 `scene.text`、语言和任务输入。
- `ai_chat`：使用 `chat.*`，不要用 `instruction.text` 代替当前聊天输入。
- `component`：自身没有独立运行入口，只在被 include 的入口上下文中渲染。

未提供的上下文会渲染为空字符串，而不是报错。不要因此跨类别滥用宏。

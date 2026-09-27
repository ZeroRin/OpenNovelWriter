---
name: "预设-场景续写"
description: "用户提供续写面板 ID 并交代后续任务时，检查面板提示词、生成或修改草稿"
---

## 适用条件

用户通过续写面板附件或位置引用提供 `panelId`，并要求检查提示词、生成或修改草稿时使用。同一会话的后续任务沿用已确定的面板。只要求检查时，报告检查结果，不进入生成流程。

## 读取材料

面板配置在交接时固定，附件只在首次发送时提供，后续复用同一组文件。读取 continuation MD 中已拼装的提示词，以及对应 JSON 中的输入信息、`missingInputs` 和绑定模型组。提示词已包含上下文；没有明确缺失或任务需要时，不额外查询正文、剧情状态等资料。可选项为空不视为缺失。

每次生成或修改草稿前，调用 `get_continuation_draft({ panelId })`，读取返回的 `mdPath`，以作者最新保存的内容为准。草稿 MD 使用单个 `## assistant` 段，正文位于 `<Content>` 中，规划位于可选的 `<Planning>` 中。

## 生成草稿

需要用户补充输入或选择写作方式时，使用当前会话提供的 `request_user_input` 或 `request_user_input_async` 打开提问面板，不以普通回复结束当前轮次来等待下一条消息。收到回答后继续执行依赖该回答的步骤。

1. 先补齐 `missingInputs` 标明的缺失项，将补充内容落实到 continuation MD 的对应提示词位置；无法确定的值向用户询问。
2. 草稿尚未生成时，通过提问面板确认写作方式，选项包含“由我直接写”和附件 `groups` 中的绑定模型组名称。由用户选择主 agent 直接写或指定模型组，不默认使用第一个模型组。用户确认后再生成。
3. 直接写作时，由主 agent 根据拼装提示词生成内容，写入草稿 MD。使用外部模型时，将 continuation MD 的路径和确认的 `groupId` 传给 `run_llm`。
4. 使用 `run_llm` 重写时，先删除 continuation MD 中上一轮生成的完整 `## assistant` 段，再运行；保留提示词原有的示例消息。仅将本次写作要求落实到生成输入，不把发给 Codex 的检查、选模型等任务原文追加为 `## user`。

## 修改草稿

直接在 `get_continuation_draft` 返回的 MD 上修改，保留作者已有的手动修改。若通过 `run_llm` 生成替换版本，将选用的 assistant 回复写入该草稿 MD。用户要求比较多个版本时，分别保存在 Artifact 中，选定后再更新草稿。

## 提交结果

生成或修改完成后，调用 `set_continuation_draft({ panelId, source: { mdPath } })`，由服务端读取文件中的 assistant 内容。若原草稿为空且使用 `run_llm` 生成，可直接提交 continuation MD 的最后一轮 assistant 回复，无需另存一份草稿 MD。Planning 和正文都通过文件提交，不在工具参数中重抄全文。结果写回续写面板，由作者决定何时采纳到正文。

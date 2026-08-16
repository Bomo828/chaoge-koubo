"use client";

import { useEffect, useRef, useState } from "react";
import {
  Brain,
  ClockCounterClockwise,
  FileText,
  GlobeHemisphereWest,
  Image as ImageIcon,
  Paperclip,
  PaperPlaneTilt,
  Plus,
  Sparkle,
  Stop,
  Trash,
  X,
} from "@phosphor-icons/react";

type AssistantConversation = {
  conversationId: string;
  model: string;
  title: string;
  lastCost: number;
  createdAt: number;
  updatedAt: number;
};

type AssistantModel = { name: string; displayName: string; description: string; tags: string[] };
type AssistantOutput = { type: "image" | "video" | "audio" | "file"; url: string; name?: string };
type AssistantSource = { title: string; url: string; snippet?: string };
type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  status?: string;
  cost?: number;
  attachments?: string[];
  outputs?: AssistantOutput[];
  sources?: AssistantSource[];
};

const welcomeMessage: AssistantMessage = {
  id: "assistant-welcome",
  role: "assistant",
  content: "您好，我是爆点 AI 助手。可以帮您查资料、读文档、梳理营销方案，也可以直接生成图片。",
};

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (typeof record.msg === "string" && record.msg.trim()) return record.msg.trim();
  }
  return fallback;
}

function fileKind(file: File) {
  if (file.type.startsWith("image/")) return "图片";
  if (file.type.includes("pdf")) return "PDF";
  if (file.type.includes("spreadsheet") || file.type.includes("excel") || file.name.endsWith(".xlsx")) return "表格";
  if (file.type.includes("presentation") || file.name.endsWith(".pptx")) return "演示文稿";
  return "文档";
}

function toolStatus(frame: Record<string, unknown>) {
  const type = String(frame.type || "");
  const stage = String(frame.stage || "");
  if (type === "web_search_status") return stage === "searched" ? "联网搜索已完成" : stage === "failed" ? "联网搜索未完成" : "正在联网搜索";
  if (type === "url_fetch_status") return stage === "fetched" ? "网页内容已读取" : stage === "failed" ? "网页读取未完成" : "正在读取网页";
  if (type === "memory_status") return stage === "saved" || stage === "updated" ? "已更新长期记忆" : "正在整理记忆";
  if (type === "doc_generate_status") return stage === "generated" ? "文档已生成" : stage === "failed" ? "文档生成未完成" : "正在生成文档";
  if (type === "generation_status") return stage === "submitted" ? "生成任务已提交" : stage === "failed" ? "媒体生成未完成" : "正在准备媒体生成";
  return "";
}

function outputType(value: unknown): AssistantOutput["type"] {
  if (value === "image" || value === "video" || value === "audio") return value;
  return "file";
}

function appendUniqueOutput(message: AssistantMessage, output: AssistantOutput) {
  const outputs = message.outputs || [];
  return outputs.some((item) => item.url === output.url) ? message : { ...message, outputs: [...outputs, output] };
}

function MessageOutputs({ outputs }: { outputs: AssistantOutput[] }) {
  return <div className="assistant-outputs">{outputs.map((output) => {
    if (output.type === "image") return <a key={output.url} href={output.url} target="_blank" rel="noreferrer"><img src={output.url} alt={output.name || "AI 生成图片"} /></a>;
    if (output.type === "video") return <video key={output.url} src={output.url} controls playsInline preload="metadata" />;
    if (output.type === "audio") return <audio key={output.url} src={output.url} controls preload="metadata" />;
    return <a className="assistant-file-result" key={output.url} href={output.url} target="_blank" rel="noreferrer"><FileText size={18} /><span>{output.name || "打开生成文件"}</span></a>;
  })}</div>;
}

export function AiAssistant({ open, memberName, onClose, onPointsChange }: {
  open: boolean;
  memberName: string;
  onClose: () => void;
  onPointsChange: (points: number) => void;
}) {
  const [model, setModel] = useState("gpt-5.4-mini");
  const [models, setModels] = useState<AssistantModel[]>([
    { name: "gpt-5.4-mini", displayName: "GPT-5.4 mini", description: "", tags: [] },
    { name: "gpt-5.4", displayName: "GPT-5.4", description: "", tags: [] },
  ]);
  const [messages, setMessages] = useState<AssistantMessage[]>([welcomeMessage]);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState("");
  const [webSearch, setWebSearch] = useState(true);
  const [memory, setMemory] = useState(true);
  const [generateImage, setGenerateImage] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadConversations();
    fetch("/api/ai/assistant/models", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { models?: AssistantModel[] }) => {
        if (Array.isArray(data.models) && data.models.length) setModels(data.models);
      })
      .catch(() => undefined);
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  async function loadConversations() {
    try {
      const response = await fetch("/api/ai/assistant/conversations", { cache: "no-store" });
      const data = await response.json() as { conversations?: AssistantConversation[] };
      if (response.ok) setConversations(data.conversations || []);
    } catch {
      // Chat remains usable when history is temporarily unavailable.
    }
  }

  function newConversation() {
    if (sending) abortRef.current?.abort();
    setConversationId("");
    setMessages([welcomeMessage]);
    setDraft("");
    setFiles([]);
    setError("");
    setHistoryOpen(false);
  }

  async function openConversation(item: AssistantConversation) {
    setLoadingHistory(true);
    setError("");
    try {
      const response = await fetch(`/api/ai/assistant/conversations/history?conversation_id=${encodeURIComponent(item.conversationId)}`, { cache: "no-store" });
      const payload = await response.json() as { data?: { messages?: Array<Record<string, unknown>> } } & Record<string, unknown>;
      if (!response.ok) throw new Error(errorMessage(payload, "对话记录暂时无法读取。"));
      const history = (payload.data?.messages || []).flatMap((round, index): AssistantMessage[] => {
        const user = typeof round.user === "string" ? round.user : "";
        const assistant = typeof round.assistant === "string" ? round.assistant : "";
        const thinking = typeof round.thinking === "string" ? round.thinking : "";
        const cost = Number(round.cost) || 0;
        return [
          ...(user ? [{ id: `history-user-${index}`, role: "user" as const, content: user }] : []),
          ...(assistant ? [{ id: `history-assistant-${index}`, role: "assistant" as const, content: assistant, thinking, cost }] : []),
        ];
      });
      setConversationId(item.conversationId);
      setModel(item.model || model);
      setMessages(history.length ? history : [welcomeMessage]);
      setHistoryOpen(false);
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : "对话记录暂时无法读取。");
    } finally {
      setLoadingHistory(false);
    }
  }

  async function deleteConversation(item: AssistantConversation) {
    if (!window.confirm(`确认删除“${item.title}”及全部聊天记录吗？`)) return;
    const response = await fetch("/api/ai/assistant/conversations/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: item.conversationId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return setError(errorMessage(payload, "对话删除失败。"));
    if (conversationId === item.conversationId) newConversation();
    await loadConversations();
  }

  async function clearMemory() {
    if (!window.confirm("确认清除这个会员账号的全部长期记忆吗？聊天记录不会删除。")) return;
    const response = await fetch("/api/ai/assistant/memories/clear", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    setError(response.ok ? "长期记忆已清除。" : errorMessage(payload, "长期记忆清除失败。"));
  }

  function updateMessage(id: string, updater: (message: AssistantMessage) => AssistantMessage) {
    setMessages((current) => current.map((message) => message.id === id ? updater(message) : message));
  }

  async function pollGeneratedTask(taskId: string, targetMessageId: string) {
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 5000));
      const response = await fetch(`/api/ai/assistant/task-status?task_id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
      const payload = await response.json() as Record<string, unknown>;
      const task = payload.data && typeof payload.data === "object"
        ? payload.data as Record<string, unknown>
        : payload;
      if (!response.ok) continue;
      const status = typeof task.status === "string" ? task.status : "正在生成媒体";
      updateMessage(targetMessageId, (message) => ({ ...message, status }));
      if (!task.is_final) continue;
      if (typeof task.result_url === "string" && task.result_url) {
        updateMessage(targetMessageId, (message) => appendUniqueOutput({ ...message, status: "生成完成" }, {
          type: outputType(task.result_type),
          url: task.result_url as string,
        }));
      } else {
        updateMessage(targetMessageId, (message) => ({ ...message, status: typeof task.error === "string" ? task.error : "媒体生成未完成" }));
      }
      return;
    }
  }

  function processFrame(frame: Record<string, unknown>, targetMessageId: string) {
    if (!frame.type) {
      const choices = Array.isArray(frame.choices) ? frame.choices : [];
      const delta = choices[0] && typeof choices[0] === "object" ? (choices[0] as { delta?: Record<string, unknown> }).delta || {} : {};
      if (typeof delta.content === "string") updateMessage(targetMessageId, (message) => ({ ...message, content: message.content + delta.content }));
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (reasoning) updateMessage(targetMessageId, (message) => ({ ...message, thinking: (message.thinking || "") + reasoning }));
      return;
    }

    const type = String(frame.type);
    if (type === "content" && typeof frame.content === "string") updateMessage(targetMessageId, (message) => ({ ...message, content: message.content + frame.content }));
    if (type === "thinking" && typeof frame.content === "string") updateMessage(targetMessageId, (message) => ({ ...message, thinking: (message.thinking || "") + frame.content }));
    if (type === "meta" && typeof frame.conversation_id === "string") setConversationId(frame.conversation_id);
    if (type === "usage") updateMessage(targetMessageId, (message) => ({ ...message, cost: Number(frame.cost) || 0 }));
    if (type === "wallet" && Number.isFinite(Number(frame.points))) onPointsChange(Number(frame.points));
    if (type === "error") {
      const message = typeof frame.message === "string" ? frame.message : "AI 助手响应中断。";
      setError(message);
      updateMessage(targetMessageId, (current) => ({ ...current, status: "响应未完成" }));
    }

    const status = toolStatus(frame);
    if (status) updateMessage(targetMessageId, (message) => ({ ...message, status }));

    if (type === "web_search_status" && frame.stage === "searched" && Array.isArray(frame.results)) {
      const sources = frame.results.map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {})
        .filter((item) => typeof item.url === "string" && typeof item.title === "string")
        .slice(0, 6)
        .map((item) => ({ title: item.title as string, url: item.url as string, snippet: typeof item.snippet === "string" ? item.snippet : "" }));
      updateMessage(targetMessageId, (message) => ({ ...message, sources }));
    }
    if (type === "doc_generate_status" && frame.stage === "generated" && typeof frame.url === "string") {
      updateMessage(targetMessageId, (message) => appendUniqueOutput(message, { type: "file", url: frame.url as string, name: typeof frame.file_name === "string" ? frame.file_name : "生成文档" }));
    }
    if (type === "generation_status" && frame.stage === "submitted" && Array.isArray(frame.task_ids)) {
      for (const taskId of frame.task_ids.map(String).filter((item) => /^\d+$/.test(item)).slice(0, 8)) void pollGeneratedTask(taskId, targetMessageId);
    }
  }

  async function uploadAttachments() {
    const urls: string[] = [];
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/ai/assistant/attachments", { method: "POST", body: form });
      const payload = await response.json() as { url?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error || `${file.name} 上传失败。`);
      urls.push(payload.url);
    }
    return urls;
  }

  async function sendMessage() {
    const messageText = draft.trim();
    if ((!messageText && !files.length) || sending) return;
    setSending(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    const userMessage: AssistantMessage = {
      id: `assistant-user-${Date.now()}`,
      role: "user",
      content: messageText || "请分析这些附件。",
      attachments: files.map((file) => `${fileKind(file)} · ${file.name}`),
    };
    const targetMessageId = `assistant-reply-${Date.now()}`;
    setMessages((current) => [...current, userMessage, { id: targetMessageId, role: "assistant", content: "", status: files.length ? "正在上传并读取附件" : "正在连接" }]);
    setDraft("");
    try {
      const attachments = files.length ? await uploadAttachments() : [];
      setFiles([]);
      const response = await fetch("/api/ai/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          request_id: `assistant_${crypto.randomUUID()}`,
          model,
          message: userMessage.content,
          ...(conversationId ? { conversation_id: conversationId } : {}),
          attachments,
          settings: { web_search: webSearch, memory, generate_image: generateImage },
        }),
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream") || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(errorMessage(payload, "AI 助手暂时无法回复。"));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          const raw = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!raw || raw === "[DONE]") continue;
          try { processFrame(JSON.parse(raw) as Record<string, unknown>, targetMessageId); } catch { /* Unknown frames are ignored. */ }
        }
      }
      updateMessage(targetMessageId, (message) => ({ ...message, status: message.outputs?.length ? "生成完成" : "回复完成" }));
      await loadConversations();
    } catch (sendError) {
      if (sendError instanceof DOMException && sendError.name === "AbortError") {
        updateMessage(targetMessageId, (message) => ({ ...message, status: "已停止" }));
      } else {
        const message = sendError instanceof Error ? sendError.message : "AI 助手暂时无法回复。";
        setError(message);
        updateMessage(targetMessageId, (current) => ({ ...current, status: "发送失败" }));
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  if (!open) return null;

  return <div className="assistant-layer" role="presentation">
    <button className="assistant-scrim" type="button" aria-label="关闭 AI 助手" onClick={onClose} />
    <section className="assistant-panel" role="dialog" aria-modal="true" aria-labelledby="assistant-title">
      <header className="assistant-head">
        <img src="/media/ai-assistant-avatar.svg" alt="" />
        <div><h2 id="assistant-title">爆点 AI 助手</h2><span>您好，{memberName}</span></div>
        <button type="button" className="assistant-icon-button" aria-label="关闭 AI 助手" onClick={onClose}><X size={19} /></button>
      </header>

      <div className="assistant-toolbar">
        <label><span>模型</span><select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item.name} value={item.name}>{item.displayName}</option>)}</select></label>
        <button type="button" onClick={() => setHistoryOpen((value) => !value)} aria-expanded={historyOpen}><ClockCounterClockwise size={17} />历史</button>
        <button type="button" onClick={newConversation}><Plus size={17} />新对话</button>
      </div>

      {historyOpen ? <div className="assistant-history">
        <div className="assistant-history-head"><b>对话记录</b><button type="button" onClick={() => void clearMemory()}><Brain size={15} />清除记忆</button></div>
        {loadingHistory ? <p>正在读取对话…</p> : conversations.length ? conversations.map((item) => <div className={conversationId === item.conversationId ? "is-active" : ""} key={item.conversationId}>
          <button type="button" onClick={() => void openConversation(item)}><b>{item.title}</b><small>{new Date(item.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></button>
          <button type="button" aria-label={`删除${item.title}`} onClick={() => void deleteConversation(item)}><Trash size={16} /></button>
        </div>) : <p>还没有保存的对话。</p>}
      </div> : null}

      <div className="assistant-messages" ref={scrollRef} aria-live="polite">
        {messages.map((message) => <article className={`assistant-message is-${message.role}`} key={message.id}>
          {message.role === "assistant" ? <img src="/media/ai-assistant-avatar.svg" alt="" /> : null}
          <div>
            <p>{message.content || (sending ? "正在思考…" : "")}</p>
            {message.attachments?.length ? <div className="assistant-attachment-list">{message.attachments.map((item) => <span key={item}><Paperclip size={13} />{item}</span>)}</div> : null}
            {message.status ? <small className="assistant-process"><Sparkle size={13} />{message.status}</small> : null}
            {message.thinking ? <details><summary>查看思考过程</summary><p>{message.thinking}</p></details> : null}
            {message.sources?.length ? <div className="assistant-sources"><b>参考来源</b>{message.sources.map((source) => <a href={source.url} key={source.url} target="_blank" rel="noreferrer"><GlobeHemisphereWest size={14} /><span>{source.title}</span></a>)}</div> : null}
            {message.outputs?.length ? <MessageOutputs outputs={message.outputs} /> : null}
            {message.role === "assistant" && message.cost ? <small className="assistant-cost">本轮消耗 {message.cost.toFixed(4)} 算力</small> : null}
          </div>
        </article>)}
      </div>

      <footer className="assistant-composer">
        {error ? <div className="assistant-error" role="status">{error}<button type="button" aria-label="关闭提示" onClick={() => setError("")}><X size={14} /></button></div> : null}
        {files.length ? <div className="assistant-pending-files">{files.map((file) => <span key={`${file.name}-${file.size}`}><Paperclip size={13} />{file.name}<button type="button" aria-label={`移除${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><X size={12} /></button></span>)}</div> : null}
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
        }} placeholder="输入问题，或上传图片和文档…" rows={3} disabled={sending} />
        <div className="assistant-compose-actions">
          <input ref={fileInputRef} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv" onChange={(event) => setFiles((current) => [...current, ...Array.from(event.target.files || [])].slice(0, 8))} />
          <button type="button" className="assistant-attach" aria-label="添加附件" onClick={() => fileInputRef.current?.click()}><Paperclip size={19} /></button>
          <div className="assistant-capabilities" aria-label="助手能力开关">
            <button type="button" aria-pressed={webSearch} onClick={() => setWebSearch((value) => !value)}><GlobeHemisphereWest size={14} />联网</button>
            <button type="button" aria-pressed={memory} onClick={() => setMemory((value) => !value)}><Brain size={14} />记忆</button>
            <button type="button" aria-pressed={generateImage} onClick={() => setGenerateImage((value) => !value)}><ImageIcon size={14} />生图</button>
          </div>
          {sending ? <button type="button" className="assistant-send is-stop" onClick={() => abortRef.current?.abort()}><Stop size={17} weight="fill" />停止</button> : <button type="button" className="assistant-send" disabled={!draft.trim() && !files.length} onClick={() => void sendMessage()}><PaperPlaneTilt size={18} weight="fill" />发送</button>}
        </div>
      </footer>
    </section>
  </div>;
}

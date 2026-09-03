"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { OntologyPanel } from "./ontology-panel";
import { PaymentWorkbench } from "./workbench/payment-workbench";

type View = "actions" | "operations" | "portfolio" | "cash" | "signals" | "data" | "release" | "blueprint" | "ontology" | "workbench";
type ImportType = "ip" | "ledger";
type ImportStage = "select" | "preview" | "done";
type ChatMessage = { role: "user" | "assistant"; content: string };
type ImportRow = Record<string, string | number | boolean | null>;
type DecisionTab = "options" | "evidence" | "assumptions";
type MetricKey = "decision" | "delegated" | "external" | "completed";
type SignalFilter = "all" | "high" | "matched" | "release";
type DecisionIssue = {
  id: string; level: "高" | "中"; title: string; summary: string; owner: string; due: string;
  state: string; impact: string; evidence: string[]; assumptions: string[];
  options: { name: string; result: string; time: string; cash: string; risk: string; recommended?: boolean }[];
};

const decisionIssues: DecisionIssue[] = [
  { id:"acm-signature", level:"高", title:"AC 米兰签名缺口可能影响限量系列发行", summary:"第二批签名仍缺 120 份。运营已完成代理催办，继续等待可能压缩设计与生产窗口。", owner:"发行运营 · 老K", due:"今天 18:00", state:"等待老板决策", impact:"约 800 张产品 · 预计上市窗口 9 月下旬", evidence:["签名台账：目标 300，已收 180","代理回复：最快 9 月 18 日确认","供应商锁产窗口：9 月 22 日"], assumptions:["人物组合可在卡面终审前调整","拆批不会触发最低发行量条款"], options:[{name:"继续等待原签名",result:"保持原人物组合",time:"可能延迟 14 天",cash:"无新增成本",risk:"中高"},{name:"调整人物组合",result:"保住原发行窗口",time:"按期",cash:"预计影响收入 -3%",risk:"中",recommended:true},{name:"拆分两批发行",result:"首批按期上市",time:"延迟 3 天",cash:"增加成本 ¥8万",risk:"低"}] },
  { id:"nufc-payment", level:"高", title:"纽卡斯尔 122 万授权费需要付款取舍", summary:"按期付款有利于续约关系，但未来 90 天现金余量将接近内部安全线。", owner:"财务 · 铁算盘", due:"9 月 8 日", state:"等待财务确认", impact:"未来 90 天现金安全余量", evidence:["合同付款日：9 月 10 日","当前资料完整度：80%","验收确认仍缺 1 份"], assumptions:["分期需要版权方书面同意","AC 米兰新品预算保持不变"], options:[{name:"按期全额付款",result:"保障合同履约",time:"按期",cash:"支出 ¥122万",risk:"低"},{name:"申请两期支付",result:"保留新品预算",time:"需 3 天沟通",cash:"本期减少 ¥61万",risk:"中",recommended:true}] },
  { id:"pb-launch", level:"中", title:"《影视 IP·代号 PB》首批演员签名计划尚未启动", summary:"人物清单已建立，但优先级、代理联络和预算边界仍未确认。", owner:"IP 运营 · 卡卡", due:"9 月 30 日", state:"运营可自行处理", impact:"首批产品立项与人物资源锁定", evidence:["已录入 21 位主要演员","尚无签名目标数量","预算待业务负责人确认"], assumptions:["首批产品聚焦 6–8 位核心人物"], options:[{name:"先锁定核心 6 人",result:"快速形成首发组合",time:"本周启动",cash:"预算可控",risk:"低",recommended:true},{name:"全名单同步询价",result:"获得完整成本视图",time:"增加 2 周",cash:"待报价",risk:"中"}] }
];

const baseIps = [
  { code: "ACM", name: "AC 米兰", kind: "足球俱乐部", contract: "2025–2027", health: 72, pay: "¥46万", stage: "发行中", risk: "1 项风险", tone: "milan" },
  { code: "NU", name: "纽卡斯尔联", kind: "足球俱乐部", contract: "2026–2028", health: 61, pay: "¥122万", stage: "筹备中", risk: "1 项风险", tone: "newcastle" },
  { code: "PB", name: "影视 IP·代号 PB", kind: "影视 IP", contract: "2026–2029", health: 30, pay: "—", stage: "待启动", risk: "需启动", tone: "peaky" },
];

const signals = [
  { date: "2026.07.23", level: "高", type: "续约官宣", person: "Luka Modrić", ip: "AC 米兰", headline: "AC 米兰官宣 Modrić 续约至 2027 年 6 月 30 日", source: "AC Milan 官方", url: "https://www.acmilan.com/en/news/articles/media/2026-07-23/official-statement-luka-modric", impact: "人物在现有签名名单（缺口 80 份）且卡表周期内持续可用；建议结合续约后的档期重新锁定签名窗口与卡面终审。", status: "已确认", matched: true, release: true },
  { date: "2026.08.27", level: "高", type: "新援官宣", person: "Nico González", ip: "纽卡斯尔联", headline: "纽卡斯尔联官宣签下 Nico González（曼城转会，长期合同）", source: "Newcastle United 官方", url: "https://www.newcastleunited.com/en/news/newcastle-united-complete-nico-gonzalez-signing", impact: "今夏第 7 笔一线队签约、身披 6 号；候选人物池新增高关注中场，建议评估进入下一季基础卡、签名卡与营销物料。", status: "已匹配", matched: true, release: true },
  { date: "2026.08.19", level: "中", type: "新援官宣", person: "Diego Moreira", ip: "AC 米兰", headline: "AC 米兰官宣从斯特拉斯堡签下 Moreira（合约至 2031）", source: "AC Milan 官方", url: "https://www.acmilan.com/en/news/articles/media/2026-08-19/official-statement-diego-moreira", impact: "长约新援具备中期卡表价值；建议纳入候选人物池，跟踪季初出场与热度后再决定是否进入限量系列。", status: "待研判", matched: true, release: false },
];

const metricTasks: Record<MetricKey, { title:string; owner:string; due:string; status:string; ai:string }[]> = {
  decision: [
    {title:"AC 米兰签名缺口：选择保期方案",owner:"老K",due:"今天 18:00",status:"待老板决定",ai:"已核对台账并生成 3 套方案"},
    {title:"纽卡斯尔授权费：全额或分期",owner:"铁算盘",due:"09 月 08 日",status:"待老板决定",ai:"已计算 90 天现金影响"},
  ],
  delegated: [
    {title:"影视 IP·代号 PB核心演员代理询价",owner:"卡卡",due:"今天",status:"执行中",ai:"已起草 6 封询价邮件"},
    {title:"AC 米兰第三批素材验收",owner:"老K",due:"10 月 15 日",status:"已授权",ai:"持续追踪交付与验收人"},
    {title:"纽卡斯尔新援候选卡表复核",owner:"小雷达",due:"本周五",status:"已授权",ai:"已匹配官方新援公告"},
  ],
  external: [
    {title:"等待 AC 米兰代理确认第二批签名",owner:"外部代理",due:"09 月 18 日",status:"等待回复",ai:"每 24 小时检查一次"},
    {title:"等待纽卡斯尔付款验收文件",owner:"版权方",due:"09 月 05 日",status:"等待文件",ai:"已发送缺件清单"},
  ],
  completed: [
    {title:"抽取 3 份合同付款节点",owner:"DAKA Agent",due:"已完成",status:"已代办",ai:"生成 7 条未来义务"},
    {title:"核对 AC 米兰 6 位人物签名进度",owner:"DAKA Agent",due:"已完成",status:"已代办",ai:"识别 2 个异常"},
    {title:"整理影视 IP·代号 PB 21 位演员名单",owner:"DAKA Agent",due:"已完成",status:"已代办",ai:"建议优先联系 6 人"},
  ],
};

const ledgerRows = [
  {id:"NU-2026-LIC",date:"2026.09.10",ip:"纽卡斯尔联",project:"年度授权费 · MG 下半年度分期",amount:"¥1,220,000",status:"待审批",owner:"铁算盘",basis:"授权合同第 4.2 条 · MG 半年付",note:"全年 MG ¥244 万分两期；净销售额超出 MG 部分按 12% 季度分成单列对账；Demo 推演"},
  {id:"SVC-AGENCY-Q3",date:"2026.09.25",ip:"共享服务",project:"海外代理协调服务费",amount:"¥86,000",status:"待核对",owner:"采购",basis:"季度服务单",note:"覆盖三个 IP 的代理沟通；Demo 推演"},
  {id:"SVC-LEGAL-09",date:"2026.10.05",ip:"共享服务",project:"授权合同法律复核",amount:"¥35,000",status:"已排期",owner:"法务",basis:"专项服务报价",note:"用于付款条款、MG 与分成条款复核；Demo 推演"},
  {id:"ACM-SIG-03",date:"2026.10.15",ip:"AC 米兰",project:"人物资源第三批 · 签名包干",amount:"¥460,000",status:"待付款",owner:"老K",basis:"人物资源补充协议",note:"按批包干，与第三批签名验收联动，超出份数按协议单价另计；Demo 推演"},
  {id:"ACM-ROY-Q3",date:"2026.11.15",ip:"AC 米兰",project:"Q3 授权分成 · 超保底溢出结算",amount:"¥186,000",status:"待对账",owner:"铁算盘",basis:"授权合同分成条款 · 超出 MG 部分 10%",note:"按 Q3 净销售额推演口径计算，需与版权方对账单核对后支付；Demo 推演"},
  {id:"PB-TALENT-01",date:"2026.11.30",ip:"影视 IP·代号 PB",project:"首批演员资源 · 立项预算",amount:"¥780,000",status:"预算中",owner:"卡卡",basis:"立项预算草案",note:"授权拟按 MG+分成结构签约，首年 MG 尚未锁定；当前为预算占用，未形成正式义务；Demo 推演"},
  {id:"ACM-LIC-H2",date:"2026.12.15",ip:"AC 米兰",project:"年度授权费 · MG 下半年度分期",amount:"¥600,000",status:"已排期",owner:"铁算盘",basis:"授权合同 · MG 半年付",note:"全年 MG ¥120 万分两期；Demo 推演"},
];

const releaseProjects = [
  {id:"acm",code:"ACM",name:"AC Milan Signatures 2026",ip:"AC 米兰",readiness:64,status:"存在风险",stage:"授权审批",milestone:"09 月 22 日锁定生产窗口",people:"Leão / Pulisic / Modrić 等 6 人",risk:"第二批签名仍缺 120 份",next:"老板选择保期方案",volume:"计划发行 5,000 张"},
  {id:"nufc",code:"NU",name:"Newcastle United First Team 2026/27",ip:"纽卡斯尔联",readiness:52,status:"待确认",stage:"人物与卡表",milestone:"09 月 10 日授权费审批",people:"Nico González 等新援候选池",risk:"新援变化需要更新人物清单",next:"复核新援授权与卡表优先级",volume:"Demo 计划 3,600 张"},
  {id:"pb",code:"PB",name:"代号 PB 演员系列",ip:"影视 IP·代号 PB",readiness:30,status:"待启动",stage:"资源询价",milestone:"09 月 30 日完成首轮代理询价",people:"主演阵容 21 位（代号 PB·演示推演）",risk:"预算边界和签名目标尚未确认",next:"先联系核心 6 位演员",volume:"Demo 计划 2,400 张"},
];

const acPlayers = [
  { name: "Rafael Leão", cn: "拉斐尔·莱昂", role: "前锋 · 葡萄牙", target: 300, got: 180, next: "09.20", state: "需跟进" },
  { name: "Christian Pulisic", cn: "克里斯蒂安·普利希奇", role: "前锋 · 美国", target: 250, got: 220, next: "10.15", state: "正常" },
  { name: "Luka Modrić", cn: "卢卡·莫德里奇", role: "中场 · 克罗地亚", target: 120, got: 40, next: "待确认", state: "需跟进" },
  { name: "Mike Maignan", cn: "迈克·迈尼昂", role: "门将 · 法国", target: 180, got: 180, next: "—", state: "已完成" },
  { name: "Fikayo Tomori", cn: "菲卡约·托莫里", role: "后卫 · 英格兰", target: 160, got: 112, next: "11.02", state: "正常" },
  { name: "Ruben Loftus-Cheek", cn: "鲁本·洛夫图斯-奇克", role: "中场 · 英格兰", target: 140, got: 98, next: "11.12", state: "正常" },
];

const nav: { id: View; label: string; icon: string }[] = [
  { id: "actions", label: "老板总控台", icon: "⌁" },
  { id: "operations", label: "运营 AI 工作台", icon: "✦" },
  { id: "release", label: "发行项目", icon: "◇" },
  { id: "portfolio", label: "IP 组合", icon: "◫" },
  { id: "cash", label: "现金与义务", icon: "¥" },
  { id: "signals", label: "变动雷达", icon: "◎" },
  { id: "data", label: "数据中心", icon: "⇧" },
  { id: "ontology", label: "本体平台", icon: "⬡" },
  { id: "workbench", label: "付款闭环调试", icon: "⌬" },
  { id: "blueprint", label: "能力蓝图", icon: "↗" },
];

function workspaceId() {
  if (typeof window === "undefined") return "demo";
  const key = "daka_demo_workspace";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = `demo_${crypto.randomUUID()}`;
  localStorage.setItem(key, id);
  return id;
}

function rowsToIps(rows: ImportRow[], limit = 17): typeof baseIps {
  return rows.slice(0, limit).map((row, index) => ({ code: String(row.code || row.ip_code || `IP${index + 4}`).slice(0, 4).toUpperCase(), name: String(row.name || row.ip_name || `新 IP ${index + 1}`), kind: String(row.kind || row.type || "待分类"), contract: String(row.contract || row.contract_period || "待补充"), health: Number(row.health || 50), pay: String(row.pay || "—"), stage: String(row.stage || "资料录入"), risk: "待校验", tone: "imported" }));
}

export default function Home() {
  const [view, setView] = useState<View>(() => {
    // 支持 ?view=<id> 直达指定视图（验收截图、trace 重开链接使用）
    if (typeof window !== "undefined") {
      const v = new URLSearchParams(window.location.search).get("view");
      if (v && nav.some((n) => n.id === v)) return v as View;
    }
    return "actions";
  });
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentFocus, setAgentFocus] = useState("当前经营全局");
  const [agentDraft, setAgentDraft] = useState("");
  const [selectedDecisionId, setSelectedDecisionId] = useState(decisionIssues[0].id);
  const [approvedDecisions, setApprovedDecisions] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importType, setImportType] = useState<ImportType>("ip");
  const [importedIps, setImportedIps] = useState<typeof baseIps>([]);
  const [importedLedgers, setImportedLedgers] = useState<ImportRow[]>([]);
  const [releaseProjectId,setReleaseProjectId]=useState("acm");
  const openImport = (type: ImportType) => { setImportType(type); setImportOpen(true); };
  const allIps = [...baseIps, ...importedIps];
  const openAgent = (focus: string, draft = "") => { setAgentFocus(focus); setAgentDraft(draft); setAgentOpen(true); };

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/data?workspaceId=${encodeURIComponent(workspaceId())}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("load failed"); return await response.json() as { ip?: ImportRow[]; ledger?: ImportRow[] }; })
      .then(data => { setImportedIps(rowsToIps(data.ip || [])); setImportedLedgers(data.ledger || []); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const resetDemoApprovals = () => {
      setApprovedDecisions([]);
      setSelectedDecisionId(decisionIssues[0].id);
    };
    resetDemoApprovals();
    window.addEventListener("pageshow", resetDemoApprovals);
    return () => window.removeEventListener("pageshow", resetDemoApprovals);
  }, []);

  return <main className={`app-shell ${collapsed ? "is-collapsed" : ""}`}>
    <aside className="sidebar">
      <div className="brand"><span>D</span><strong>DAKA CONTROL <small>v1.2</small></strong><button className="collapse-button" aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} onClick={() => setCollapsed(v => !v)}>{collapsed ? "›" : "‹"}</button></div>
      <nav aria-label="主导航">{nav.map((item) => <button key={item.id} title={item.label} onClick={() => setView(item.id)} className={`nav-item ${view === item.id ? "active" : ""}`}><b>{item.icon}</b><span>{item.label}</span>{item.id === "signals" && <em>3</em>}</button>)}</nav>
      <div className="sidebar-bottom"><button className="agent-launch" onClick={() => openAgent("当前经营全局")}><span>✦</span><div><b>GLM 经营 Agent</b><small>讨论方案与经营影响</small></div></button><button className="settings-button" onClick={() => setSettingsOpen(true)}><span>⚙</span><div><b>设置</b><small>模型、数据源与偏好</small></div></button></div>
    </aside>
    <section className="workspace">
      <div className="utility-bar"><button className="mobile-menu" onClick={() => setCollapsed(v => !v)}>☰</button><div><span className="system-dot" /><b className="demo-flag">DEMO</b>演示推演数据 · 外部新闻链接真实可核验</div><button className="quick-import" onClick={() => openImport("ip")}>＋ 导入数据</button><span className="avatar" aria-label="演示访客">访客</span></div>
      {view === "actions" && <BossControl selectedId={selectedDecisionId} approved={approvedDecisions} onSelect={setSelectedDecisionId} onApprove={id => setApprovedDecisions(prev => prev.includes(id) ? prev : [...prev,id])} onAsk={openAgent} onOperations={() => setView("operations")} />}
      {view === "operations" && <OperationsWorkbench approved={approvedDecisions} onEscalate={(id) => { setSelectedDecisionId(id); setView("actions"); }} onAsk={openAgent} />}
      {view === "portfolio" && <Portfolio ips={allIps} onImport={() => openImport("ip")} onOpenIP={(code) => {setReleaseProjectId(code==="NU"?"nufc":code==="PB"?"pb":"acm");setView("release");}} onAsk={openAgent} />}
      {view === "cash" && <CashDashboard onImport={() => openImport("ledger")} importedRows={importedLedgers} />}
      {view === "signals" && <SignalRadar onAsk={openAgent} />}
      {view === "data" && <DataCenter onImport={openImport} />}
      {view === "release" && <Release initialProjectId={releaseProjectId} onBlueprint={() => setView("blueprint")} />}
      {view === "ontology" && <OntologyPanel />}
      {view === "workbench" && <PaymentWorkbench />}
      {view === "blueprint" && <Blueprint />}
      <footer>DAKA AI 经营控制塔 · 新闻与经营数字均明确标记演示属性，不构成真实业务事实</footer>
    </section>
    {importOpen && <ImportDrawer type={importType} onType={setImportType} onClose={() => setImportOpen(false)} onImported={(rows) => { if (importType === "ip") setImportedIps(prev => [...prev, ...rowsToIps(rows, Math.max(0, 20 - allIps.length))]); else setImportedLedgers(prev => [...prev, ...rows]); }} />}
    {agentOpen && <AgentDrawer view={view} focus={agentFocus} draft={agentDraft} onClose={() => setAgentOpen(false)} />}
    {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
  </main>;
}

function PageHeader({ eyebrow, title, sub, actions }: { eyebrow: string; title: string; sub: string; actions?: React.ReactNode }) {
  return <header className="topbar"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="subtitle">{sub}</p></div>{actions&&<div className="topbar-actions">{actions}</div>}</header>;
}

function BossControl({ selectedId, approved, onSelect, onApprove, onAsk, onOperations }: { selectedId:string; approved:string[]; onSelect:(id:string)=>void; onApprove:(id:string)=>void; onAsk:(focus:string)=>void; onOperations:()=>void }) {
  const item = decisionIssues.find(issue => issue.id === selectedId) || decisionIssues[0];
  const done = approved.includes(item.id);
  const [metric, setMetric] = useState<MetricKey>("decision");
  const [tab, setTab] = useState<DecisionTab>("options");
  const [selectedOptions,setSelectedOptions]=useState<Record<string,string>>({});
  const selectedOption=selectedOptions[item.id]||item.options.find(option=>option.recommended)?.name||item.options[0].name;
  const pendingHigh = decisionIssues.filter(issue => issue.level === "高" && !approved.includes(issue.id)).length;
  const metricLabels: Record<MetricKey,string> = {decision:"需要老板决定",delegated:"已授权团队处理",external:"等待外部确认",completed:"本周 AI 已代办"};
  return <><PageHeader eyebrow="老板经营总控 · DECISION CONTROL" title={pendingHigh > 0 ? `今天有 ${pendingHigh} 项需要你拍板` : "今天的拍板事项已全部处理"} sub="AI 与团队已处理日常跟进；这里只保留影响收入、现金、交期或品牌的例外事项。" actions={<button className="role-jump" onClick={onOperations}>切换到运营工作台 →</button>} />
    <div className="decision-metrics"><button className={metric==="decision"?"active":""} onClick={()=>setMetric("decision")}><small>需要老板决定</small><strong>{pendingHigh}</strong><p>1 项今天到期</p></button><button className={metric==="delegated"?"active":""} onClick={()=>setMetric("delegated")}><small>已授权团队处理</small><strong>{7+approved.length}</strong><p>AI 持续追踪</p></button><button className={metric==="external"?"active":""} onClick={()=>setMetric("external")}><small>等待外部确认</small><strong>4</strong><p>无需现在介入</p></button><button className={`ai-proof ${metric==="completed"?"active":""}`} onClick={()=>setMetric("completed")}><small>本周 AI 已代办</small><strong>26</strong><p>预计节省 11.5 小时</p></button></div>
    <section className="panel metric-drilldown"><div className="panel-head"><div><span>指标明细</span><h2>{metricLabels[metric]}</h2></div><em>点击上方指标切换</em></div><div className="task-detail-head"><span>事项</span><span>负责人 / 截止</span><span>状态</span><span>AI 已执行</span></div>{metricTasks[metric].map(task=><div className="task-detail-row" key={task.title}><b>{task.title}</b><span>{task.owner}<small>{task.due}</small></span><em>{task.status}</em><span>{task.ai}</span></div>)}</section>
    <div className="decision-layout"><section className="panel decision-inbox"><div className="panel-head"><div><span>DECISION INBOX</span><h2>需要介入的经营事项</h2></div><em>按经营影响排序</em></div>{decisionIssues.map(issue=><button key={issue.id} className={`decision-row ${selectedId===issue.id?"selected":""}`} onClick={()=>onSelect(issue.id)}><span className={`decision-level level-${issue.level}`}>{issue.level}</span><div><small>{approved.includes(issue.id)?"已完成决策":issue.state} · {issue.due}</small><h3>{issue.title}</h3><p>{issue.impact}</p></div><b>{approved.includes(issue.id)?"✓":"→"}</b></button>)}</section>
      <section className="panel decision-detail"><div className="decision-title"><div><span className={`decision-level level-${item.level}`}>{item.level}影响</span><small>{done?`已批准：${selectedOption}`:item.state}</small></div><h2>{item.title}</h2><p>{item.summary}</p></div><div className="decision-owner"><span>当前责任人</span><b>{item.owner}</b><span>必须处理</span><b>{item.due}</b></div><div className="decision-tabs" role="tablist"><button className={tab==="options"?"active":""} onClick={()=>setTab("options")}>方案比较</button><button className={tab==="evidence"?"active":""} onClick={()=>setTab("evidence")}>依据 {item.evidence.length}</button><button className={tab==="assumptions"?"active":""} onClick={()=>setTab("assumptions")}>假设 {item.assumptions.length}</button></div>{tab==="options"&&<><div className="option-grid">{item.options.map(option=><button type="button" key={option.name} aria-pressed={selectedOption===option.name} onClick={()=>setSelectedOptions(prev=>({...prev,[item.id]:option.name}))} className={`${option.recommended?"recommended":""} ${selectedOption===option.name?"selected":""}`}>{option.recommended&&<em>AI + 运营推荐</em>}<i className="option-check">{selectedOption===option.name?"✓":""}</i><h3>{option.name}</h3><p>{option.result}</p><dl><dt>上市时间</dt><dd>{option.time}</dd><dt>现金 / 收入</dt><dd>{option.cash}</dd><dt>风险</dt><dd>{option.risk}</dd></dl></button>)}</div><p className="selected-option-note">当前选择：<b>{selectedOption}</b>。选择方案不会自动批准。</p></>}{tab==="evidence"&&<div className="tab-list"><b>已确认的判断依据</b>{item.evidence.map((x,i)=><p key={x}><span>{i+1}</span>{x}</p>)}</div>}{tab==="assumptions"&&<div className="tab-list assumption"><b>尚未验证，不应当作事实</b>{item.assumptions.map((x,i)=><p key={x}><span>{i+1}</span>{x}</p>)}</div>}<div className="decision-actions"><button onClick={()=>onAsk(`${item.title}：请比较当前方案并解释关键假设；我当前选择 ${selectedOption}`)}>与 Agent 讨论方案</button><button className="primary" disabled={done} onClick={()=>onApprove(item.id)}>{done?"✓ 已生成运营行动":`批准「${selectedOption}」`}</button></div></section></div></>;
}

function OperationsWorkbench({ approved, onEscalate, onAsk }: { approved:string[]; onEscalate:(id:string)=>void; onAsk:(focus:string)=>void }) {
  const acApproved = approved.includes("acm-signature");
  const [filter,setFilter]=useState<"pending"|"missing"|"escalate"|"auto">("pending");
  const [notice,setNotice]=useState("");
  const labels={pending:"AI 已完成，待确认",missing:"需要补充信息",escalate:"需要升级老板",auto:"今日已自动推进"};
  return <><PageHeader eyebrow="发行运营 · AI WORKBENCH" title="AI 已完成初步处理，等待你确认 4 项" sub="运营处理事实核对、日常推进与升级；超过权限阈值的事项才进入老板决策收件箱。" actions={<div className="operator-chip"><span>K</span><div><b>老K</b><small>发行运营负责人</small></div></div>} />
    <div className="ops-stats"><button className={filter==="pending"?"active":""} onClick={()=>setFilter("pending")}><span>AI 已完成，待确认</span><b>4</b></button><button className={filter==="missing"?"active":""} onClick={()=>setFilter("missing")}><span>需要补充信息</span><b>3</b></button><button className={filter==="escalate"?"active":""} onClick={()=>setFilter("escalate")}><span>需要升级老板</span><b>{acApproved?1:2}</b></button><button className={filter==="auto"?"active":""} onClick={()=>setFilter("auto")}><span>今日已自动推进</span><b>12</b></button></div>
    <div className="ops-layout"><section className="panel ops-queue"><div className="panel-head"><div><span>AI REVIEW QUEUE</span><h2>{labels[filter]}</h2></div><em>点击上方指标切换</em></div>{notice&&<div className="action-notice">✓ {notice}<button onClick={()=>setNotice("")}>关闭</button></div>}
      {(filter==="pending"||filter==="escalate")&&<article className="ops-item urgent"><div className="ops-item-top"><span>需要升级老板</span><small>8 分钟前</small></div><h3>AC 米兰第二批签名缺口 120 份</h3><p>AI 已核对签名台账、代理回复和供应商锁产时间，判断超出运营可调整范围。</p><div className="ai-worklog"><b>✦ AI 已完成</b><span>核对 6 位人物进度</span><span>匹配 1 个在途项目</span><span>生成 3 套方案</span></div><div className="ops-buttons"><button onClick={()=>onAsk("AC 米兰签名缺口：帮助运营检查升级材料是否完整")}>检查 AI 依据</button><button className="primary" onClick={()=>onEscalate("acm-signature")}>{acApproved?"查看老板决定":"升级老板决策"}</button></div></article>}
      {filter==="pending"&&<article className="ops-item"><div className="ops-item-top"><span className="auto">可由运营确认</span><small>21 分钟前</small></div><h3>影视 IP·代号 PB首批演员联络顺序</h3><p>AI 建议先锁定 6 位核心人物，并已按角色重要度与公开热度生成联络顺序。</p><div className="ai-worklog"><b>✦ AI 已完成</b><span>整理 21 位演员</span><span>标记 6 位核心人物</span><span>起草代理询价邮件</span></div><div className="ops-buttons"><button onClick={()=>onAsk("展示影视 IP·代号 PB核心 6 位演员的代理询价邮件草稿")}>查看草稿</button><button className="primary" onClick={()=>setNotice("已确认联络顺序；Demo 中不会真实发送外部邮件")}>确认执行</button></div></article>}
      {filter==="missing"&&<article className="ops-item"><div className="ops-item-top"><span className="missing">缺少信息</span><small>今天 09:10</small></div><h3>AC 米兰第三批资源验收</h3><p>系统缺少验收负责人，无法自动创建 10 月 15 日检查点。</p><div className="ops-buttons"><button onClick={()=>setNotice("已指派老K为演示验收负责人")}>补充负责人</button><button onClick={()=>setNotice("事项已暂缓至明天 10:00，并保留提醒")}>暂缓处理</button></div></article>}
      {filter==="auto"&&<>{[["09:42","核对 AC 米兰签名台账","识别 2 个异常"],["09:31","匹配纽卡斯尔新援官宣","创建人物复核建议"],["09:18","提取合同付款节点","生成 7 条义务"]].map(x=><article className="ops-item auto-item" key={x[0]}><div className="ops-item-top"><span className="auto">已自动推进</span><small>{x[0]}</small></div><h3>{x[1]}</h3><p>{x[2]}；完整过程已进入审计记录。</p><div className="ops-buttons"><button onClick={()=>onAsk(`解释 AI 自动推进记录：${x[1]}`)}>查看执行记录</button></div></article>)}</>}</section>
      <aside className="ops-side"><section className="panel"><div className="panel-head"><div><span>AGENT ACTIVITY</span><h2>AI 今天替你做了什么</h2></div></div>{[["09:42","核对 AC 米兰签名台账","6 人"],["09:31","匹配外部人物变化","3 条"],["09:18","提取合同付款节点","2 项"],["08:55","生成催办邮件草稿","4 封"]].map(x=><div className="activity-row" key={x[0]}><time>{x[0]}</time><div><b>{x[1]}</b><small>{x[2]}</small></div><span>✓</span></div>)}</section><section className="panel boundary-card"><p className="eyebrow">DECISION RIGHTS</p><h2>什么情况必须升级？</h2><ul><li>影响发行日期超过 7 天</li><li>新增成本超过 ¥5 万</li><li>变更核心人物或产品定位</li><li>付款与合同条款发生变化</li></ul><button onClick={()=>onAsk("请解释当前运营升级老板的决策权限规则")}>让 Agent 解释边界 →</button></section></aside></div></>;
}

const licenseTimeline = [
  { name: "AC 米兰", term: "2025–2027 · 剩余约 16 个月", tone: "lb-milan", width: 50, alertAt: 25, alertText: "2026.12 续约谈判窗口", hot: true },
  { name: "纽卡斯尔联", term: "2026–2028", tone: "lb-newcastle", width: 75, alertAt: 50, alertText: "2027.12 续约窗口", hot: false },
  { name: "影视 IP·代号 PB", term: "2026–2029 · 待启动", tone: "lb-peaky", width: 100, alertAt: 75, alertText: "2028.12 续约窗口", hot: false },
];
const mgAlerts = [
  { ip: "AC 米兰", level: "高", title: "年度 MG 达成率 82%，Q4 存在补提差额风险", detail: "全年 MG ¥120 万（推演）；前三季分成计提 ¥98 万。若 Q4 销售不及推演，需按合同补提差额最高约 ¥22 万。", action: "10 月与版权方预对账" },
  { ip: "纽卡斯尔联", level: "中", title: "MG 下半年度分期 ¥122 万，9 月 10 日到期", detail: "全年 MG ¥244 万分两期（推演）；H2 分期已在台账待审批；Q3 分成对账单预计 10 月出具。", action: "进入付款审批流程" },
  { ip: "影视 IP·代号 PB", level: "中", title: "首年 MG 目标区间尚未锁定", detail: "授权拟按 MG+分成结构签约（参考同类影视 IP 5–8% 版税口径）；首批立项前应先锁定 MG 与分成比例。", action: "发起立项评审" },
];

function Portfolio({ ips, onImport, onOpenIP, onAsk }: { ips: typeof baseIps; onImport: () => void; onOpenIP: (code:string) => void; onAsk: (focus: string, draft?: string) => void }) {
  const [filter,setFilter]=useState<"all"|"risk"|"pay"|"start">("all");
  const visible=ips.filter(ip=>filter==="all"||(filter==="risk"&&["ACM","NU"].includes(ip.code))||(filter==="pay"&&["ACM","NU"].includes(ip.code))||(filter==="start"&&ip.stage==="待启动"));
  return <><PageHeader eyebrow="IP PORTFOLIO" title="现有 IP 组合，一眼看到风险与下一步" sub="三个演示 IP 均来自真实合作组合；经营数字为演示推演。" actions={<button className="primary" onClick={onImport}>＋ 导入新 IP</button>} /><div className="filter-row"><button className={filter==="all"?"selected":""} onClick={()=>setFilter("all")}>全部 {ips.length}</button><button className={filter==="risk"?"selected":""} onClick={()=>setFilter("risk")}>有风险 2</button><button className={filter==="pay"?"selected":""} onClick={()=>setFilter("pay")}>90 天内付款 2</button><button className={filter==="start"?"selected":""} onClick={()=>setFilter("start")}>待启动 1</button><span>当前显示 {visible.length} 个 IP</span></div><section className="portfolio-grid">{visible.map(ip => <button className="ip-card" key={`${ip.code}-${ip.name}`} onClick={()=>onOpenIP(ip.code)}><div className={`ip-mark ${ip.tone}`}>{ip.code}</div><div className="ip-card-head"><div><h2>{ip.name}</h2><p>{ip.kind} · {ip.contract}</p></div><span>{ip.stage}</span></div><div className="health"><div><small>资源健康度</small><b>{ip.health}%</b></div><i><em style={{width:`${Math.min(100, ip.health)}%`}} /></i></div><div className="ip-facts"><div><small>近期付款</small><b>{ip.pay}</b></div><div><small>当前提醒</small><b>{ip.risk}</b></div></div></button>)}</section>
  <section className="panel license-panel">
    <div className="panel-head"><div><span>LICENSE TIMELINE · 演示推演</span><h2>授权到期与续约谈判窗口</h2></div><em>提前 12 个月进入续约评估，防止 IP 流失</em></div>
    <div className="license-track">
      <div className="license-scale">{["2026","2027","2028","2029","2030"].map(y=><span key={y}>{y}</span>)}</div>
      {licenseTimeline.map(item=><div className="license-row" key={item.name}><div className="license-label"><b>{item.name}</b><small>{item.term}</small></div><div className="license-bar-area"><i className="license-today" style={{left:"17%"}} /><span className={`license-bar-tone ${item.tone}`} style={{width:`${item.width}%`}}>{item.term}</span><em className={`license-alert ${item.hot?"hot":""}`} style={{left:`${item.alertAt}%`}}>{item.alertText}</em></div></div>)}
    </div>
    <div className="mg-grid">{mgAlerts.map(card=><div className={`mg-card ${card.level==="高"?"hot":""}`} key={card.ip}><div className="mg-head"><span className={`mg-level level-${card.level}`}>{card.level}</span><b>{card.ip}</b></div><h3>{card.title}</h3><p>{card.detail}</p><button className="mg-action" onClick={() => onAsk(`${card.ip} · MG 预警`, `「${card.ip}」${card.title}。${card.detail} 请围绕「${card.action}」给出具体执行步骤、需要的材料、负责人建议与时间节点，并指出最大的风险点。`)}>建议动作 · {card.action} ↗</button></div>)}</div>
  </section></>;
}

type LedgerRowView = (typeof ledgerRows)[number] & { imported?: boolean };

function CashDashboard({ onImport, importedRows }: { onImport: () => void; importedRows: ImportRow[] }) {
  const importedLedger: LedgerRowView[] = importedRows.map((row, index) => { const num = Number(String(row.amount ?? row.金额 ?? 0).replace(/[^0-9.-]/g, "")) || 0; return { id: `IMP-${index + 1}`, date: String(row.date ?? row.日期 ?? "待补充"), ip: String(row.ip ?? row.IP ?? row.合同方 ?? "导入账目"), project: `${String(row.category ?? row.类型 ?? row.project ?? "导入账目")} · 导入`, amount: num ? `¥${num.toLocaleString("zh-CN")}` : "—", status: String(row.status ?? row.状态 ?? "已导入"), owner: String(row.owner ?? row.负责人 ?? "导入文件"), basis: "导入文件 · 待对账", note: "来自演示导入；未与主数据对账", imported: true }; });
  const allRows: LedgerRowView[] = [...ledgerRows, ...importedLedger];
  const amountOf = (row: LedgerRowView) => Number(String(row.amount).replace(/[^0-9.-]/g, "")) || 0;
  const totalWan = Math.round(allRows.reduce((sum, row) => sum + amountOf(row), 0) / 10_000);
  const importedWan = Math.round(importedLedger.reduce((sum, row) => sum + amountOf(row), 0) / 10_000);
  const months = (() => { const defs: [string, string][] = [["2026-09", "9月"], ["2026-10", "10月"], ["2026-11", "11月"], ["2026-12", "12月"], ["2027-01", "1月"], ["2027-02", "2月"]]; const sums = new Map<string, number>(); for (const row of allRows) { const match = row.date.match(/^(\d{4})[-.](\d{2})/); if (!match) continue; const key = `${match[1]}-${match[2]}`; sums.set(key, (sums.get(key) || 0) + amountOf(row) / 10_000); } const values = defs.map(([key, label]) => ({ m: label, v: Math.round(sums.get(key) || 0) })); const max = Math.max(1, ...values.map(x => x.v)); return values.map(x => ({ ...x, p: Math.max(4, Math.round(x.v / max * 100)) })); })();
  const donutColors: { label: string; color: string }[] = [{ label: "纽卡斯尔联", color: "#577fce" }, { label: "AC 米兰", color: "#233f34" }, { label: "影视 IP·代号 PB", color: "#d8a44d" }, { label: "共享服务", color: "#8a93a6" }];
  const donutGroups = donutColors.map(group => { const v = Math.round(allRows.filter(row => row.ip === group.label).reduce((sum, row) => sum + amountOf(row), 0) / 10_000); return { ...group, v, pct: totalWan ? Math.round(v / totalWan * 100) : 0 }; });
  const donutGradient = (() => { let acc = 0; const parts = donutGroups.map(group => { const from = acc; acc = Math.min(100, acc + group.pct); return `${group.color} ${from}% ${acc}%`; }); return `conic-gradient(${parts.join(",")})`; })();
  const [selected,setSelected]=useState<LedgerRowView>(ledgerRows[0]);
  const [metric,setMetric]=useState<"payable"|"paid"|"approval"|"overdue">("payable");
  const cashDetails={payable:{title:"未来 180 天应付构成",copy:"授权费、人物资源与共享服务义务合计；按到期日持续更新。",rows:allRows},paid:{title:"本月已支付 ¥74 万",copy:"较原计划少支付 ¥12 万，主要来自服务验收顺延。",rows:[]},approval:{title:"待审批 ¥122 万",copy:"纽卡斯尔联年度授权费等待验收文件与老板批准。",rows:allRows.filter(x=>x.status==="待审批")},overdue:{title:"逾期风险 1 项",copy:"当前尚未逾期；若 9 月 10 日前未完成审批，将进入风险状态。",rows:allRows.filter(x=>x.id==="NU-2026-LIC")}};
  const exportCsv=()=>{const head=["到期日","IP/合同","项目","金额","状态","负责人","依据","备注","来源"];const rows=allRows.map(x=>[x.date,x.ip,x.project,x.amount,x.status,x.owner,x.basis,x.note,x.imported?"导入":"Demo"]);const csv="\uFEFF"+[head,...rows].map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download="DAKA_近期义务_Demo.csv";a.click();URL.revokeObjectURL(url);};
  const active=cashDetails[metric];
  return <><PageHeader eyebrow="CASH & OBLIGATIONS" title="账目不是流水，是未来经营动作" sub="把合同付款义务、已付账目和发行节点放在同一条时间线上。" actions={<button className="primary" onClick={onImport}>＋ 导入账目</button>} /><div className="summary-grid cash-summary"><button className={`summary dark ${metric==="payable"?"active":""}`} onClick={()=>setMetric("payable")}><small>未来 180 天应付</small><strong>{`¥${totalWan}万`}</strong><p>已覆盖 {new Set(allRows.map(row=>row.ip)).size} 个对象{importedWan>0?` · 含导入 ¥${importedWan}万`:""}</p></button><button className={`summary ${metric==="paid"?"active":""}`} onClick={()=>setMetric("paid")}><small>本月已支付</small><strong>¥74万</strong><p>较计划少 ¥12万</p></button><button className={`summary ${metric==="approval"?"active":""}`} onClick={()=>setMetric("approval")}><small>待审批</small><strong>¥122万</strong><p>纽卡斯尔授权费</p></button><button className={`summary risk ${metric==="overdue"?"active":""}`} onClick={()=>setMetric("overdue")}><small>逾期风险</small><strong>1 项</strong><p>需在 9 月 10 日前处理</p></button></div><section className="panel cash-drilldown"><div><small>指标明细</small><h2>{active.title}</h2><p>{active.copy}</p></div><div>{active.rows.length?active.rows.slice(0,3).map(row=><button key={row.id} onClick={()=>setSelected(row)}><span>{row.date}</span><b>{row.ip} · {row.project}</b><em>{row.amount}</em></button>):<p>演示空间显示汇总结果；导入真实已付账目后可下钻到逐笔凭证。</p>}</div></section><div className="dashboard-grid"><section className="panel chart-panel"><div className="panel-head"><div><span>未来 6 个月</span><h2>付款压力分布</h2></div><b>单位：万元</b></div><div className="bar-chart">{months.map(x => <div className="bar-col" key={x.m}><span>{x.v}</span><i style={{height:`${x.p}%`}} /><small>{x.m}</small></div>)}</div></section><section className="panel"><div className="panel-head"><div><span>按 IP 聚合</span><h2>预算占用</h2></div></div><div className="donut-wrap"><div className="donut" style={{background:donutGradient}}><b>{`¥${totalWan}万`}</b><small>应付总额</small></div><ul className="legend">{donutGroups.map(group=><li key={group.label}><i style={{background:group.color}} />{group.label} <b>{group.pct}%</b></li>)}</ul></div></section></div><section className="panel ledger-table"><div className="panel-head"><div><span>付款与服务台账 · Demo</span><h2>近期义务</h2></div><button onClick={exportCsv}>导出 CSV</button></div><div className="ledger-row head"><span>到期日</span><span>IP / 合同</span><span>项目</span><span>金额</span><span>状态</span></div>{allRows.map(r=><button className={`ledger-row ${selected.id===r.id?"selected":""}`} key={r.id} onClick={()=>setSelected(r)}><span>{r.date}</span><span>{r.ip}</span><span>{r.project}</span><span>{r.amount}</span><span className="state-pill">{r.status}</span></button>)}<div className="ledger-detail"><div><small>当前责任人</small><b>{selected.owner}</b></div><div><small>付款 / 预算依据</small><b>{selected.basis}</b></div><div><small>说明</small><b>{selected.note}</b></div></div></section></>;
}

function SignalRadar({ onAsk }: { onAsk: (focus: string, draft?: string) => void }) {
  const [selected, setSelected] = useState(0); const [filter,setFilter]=useState<SignalFilter>("all");
  const visible=signals.map((s,i)=>({...s,index:i})).filter(s=>filter==="all"||(filter==="high"&&s.level==="高")||(filter==="matched"&&s.matched)||(filter==="release"&&s.release));
  const item = signals[selected] || signals[0];
  return <><PageHeader eyebrow="IP CHANGE RADAR" title="外部世界发生变化，系统告诉你影响什么" sub="事实来源、人物匹配和经营影响分层呈现；未经确认的新闻不会修改主数据。" /><div className="summary-grid signal-summary"><button className={`summary dark ${filter==="all"?"active":""}`} onClick={()=>setFilter("all")}><small>当前演示信号</small><strong>3</strong><p>链接真实可核验</p></button><button className={`summary ${filter==="high"?"active":""}`} onClick={()=>setFilter("high")}><small>高影响</small><strong>2</strong><p>需要今天研判</p></button><button className={`summary ${filter==="matched"?"active":""}`} onClick={()=>setFilter("matched")}><small>已自动匹配</small><strong>3/3</strong><p>查看已匹配人物</p></button><button className={`summary ${filter==="release"?"active":""}`} onClick={()=>setFilter("release")}><small>可能影响发行</small><strong>2</strong><p>关联在途项目</p></button></div><div className="radar-layout"><section className="panel radar-list"><div className="panel-head"><div><span>真实信号源 · {visible.length} 条示例</span><h2>与当前 IP 相关</h2></div><button disabled title="在左下角设置中配置">数据源设置</button></div>{visible.map(s=><button className={`radar-item ${selected===s.index?"selected":""}`} key={`${s.person}-${s.date}`} onClick={()=>setSelected(s.index)}><span className={`impact-dot ${s.level}`}>{s.level}</span><div><small>{s.date} · {s.type}</small><h3>{s.headline}</h3><p>{s.person} · {s.ip}</p></div><em>{s.status}</em></button>)}</section><aside className="panel signal-detail"><div className="detail-kicker"><span className="status red">{item.level}影响</span><small>{item.status}</small></div><h2>{item.person}</h2><p className="headline">{item.headline}</p><dl><dt>关联 IP</dt><dd>{item.ip}</dd><dt>来源与可信度</dt><dd>{item.source} · 官方来源</dd><dt>系统匹配依据</dt><dd>英文名 + 俱乐部 + 人物候选池</dd><dt>可能的经营影响</dt><dd>{item.impact}</dd></dl><div className="guardrail">新闻是外部信号，不是主数据。只有官方材料核对或人工确认后，系统才会创建关系记录；历史关系不会被覆盖。</div><div className="signal-actions"><a href={item.url} target="_blank" rel="noreferrer">查看官方来源 ↗</a><button className="primary" onClick={() => onAsk(`${item.person} 外部变动`, `「${item.headline}」（${item.source}）对 ${item.ip} 的在售与在途产品有什么影响？请给出应对动作、优先级与需要老板确认的事项。`)}>让 Agent 分析应对动作</button></div></aside></div></>;
}

function DataCenter({ onImport }: { onImport: (type: ImportType) => void }) {
  return <><PageHeader eyebrow="DATA CENTER" title="把代理手里的表，变成公司的经营数据" sub="每次导入都有校验、差异、回执与审计记录，可追溯到原始文件。" /><section className="import-cards"><button onClick={()=>onImport("ip")}><span>IP</span><div><h2>导入 IP 主档</h2><p>名称、类型、合同周期、负责人及经营状态</p></div><b>开始导入 →</b></button><button onClick={()=>onImport("ledger")}><span>¥</span><div><h2>导入账目</h2><p>应收应付、合同义务、发生日期、金额及状态</p></div><b>开始导入 →</b></button><button className="disabled" disabled title="即将支持"><span>▤</span><div><h2>合同与签名台账</h2><p>即将支持 PDF 提取与人物资源批量录入</p></div><b>即将支持</b></button></section><div className="data-grid"><section className="panel quality-panel"><div className="panel-head"><div><span>数据质量</span><h2>当前主数据健康度</h2></div><strong>82%</strong></div>{[["IP 基础信息","100%"],["合同与付款字段","78%"],["人物实体匹配","86%"],["签名资源台账","64%"]].map(x=><div className="quality-row" key={x[0]}><span>{x[0]}</span><i><em style={{width:x[1]}} /></i><b>{x[1]}</b></div>)}</section><section className="panel import-history"><div className="panel-head"><div><span>导入任务</span><h2>最近记录</h2></div><span>显示全部 3 条</span></div>{[["ACM_球员名单_2026.xlsx","人物资源","126 行","已完成"],["Q3_授权费台账.csv","账目","18 行","已完成"],["PB_演员清单.xlsx","人物资源","21 行","3 条待确认"]].map((x,i)=><div className="history-row" key={i}><span className="file-icon">{i===1?"CSV":"XLS"}</span><div><b>{x[0]}</b><small>{x[1]} · {x[2]}</small></div><em>{x[3]}</em></div>)}</section></div><section className="panel audit-panel"><div><p className="eyebrow">完整审计链</p><h2>知道谁、在什么时候、从哪份文件改了什么</h2><p>原始文件保存到对象存储，结构化记录进入数据库；每一行都保留来源行号与字段差异。</p></div><div className="audit-flow"><span>原始文件</span><i>→</i><span>字段映射</span><i>→</i><span>数据校验</span><i>→</i><span>确认入库</span><i>→</i><span>审计回执</span></div></section></>;
}

function Release({ initialProjectId, onBlueprint }: { initialProjectId:string; onBlueprint: () => void }) {
  const [projectId,setProjectId]=useState(initialProjectId); const project=releaseProjects.find(x=>x.id===projectId)||releaseProjects[0];
  return <><PageHeader eyebrow="RELEASE CONTROL · DEMO" title="三个业务方向，一套发行推进方法" sub="项目数字为演示推演；人物变动信号来自可核验的官方来源。" /><div className="project-switcher">{releaseProjects.map(p=><button className={p.id===projectId?"active":""} key={p.id} onClick={()=>setProjectId(p.id)}><span>{p.code}</span><div><b>{p.ip}</b><small>{p.stage} · {p.readiness}%</small></div></button>)}</div><section className="release-hero"><div><span className="status amber">{project.status}</span><h2>{project.name}</h2><p>{project.volume} · {project.milestone}</p></div><div className="release-number"><small>发行准备度</small><strong>{project.readiness}%</strong></div></section><section className="project-facts"><article><small>当前阶段</small><b>{project.stage}</b></article><article><small>人物 / 资源</small><b>{project.people}</b></article><article><small>主要风险</small><b>{project.risk}</b></article><article><small>下一步行动</small><b>{project.next}</b></article></section>{project.id==="acm"?<div className="detail-grid"><section className="panel roster-panel"><div className="panel-head"><div><span>人物与签名供给</span><h2>核心人物资源</h2></div></div><div className="player-table"><div className="player-row table-head"><span>人物</span><span>年度计划</span><span>已获取</span><span>下一批</span><span>状态</span></div>{acPlayers.map(p=><div className="player-row" key={p.name}><div><b>{p.name}</b><small>{p.cn} · {p.role}</small></div><span>{p.target}</span><span>{p.got}<i className="mini-track"><em style={{width:`${Math.round(p.got/p.target*100)}%`}} /></i></span><span>{p.next}</span><span className={p.state==="需跟进"?"text-risk":"text-good"}>{p.state}</span></div>)}</div></section><aside className="panel future-hook"><p className="eyebrow">审批之后</p><h2>同一个项目继续进入供应链</h2><p>审批完成后继续追踪供应商、生产批次、限量序列号、抽检记录和入库数量。</p><button className="primary full" onClick={onBlueprint}>查看能力蓝图</button></aside></div>:<section className="panel project-milestones"><div className="panel-head"><div><span>项目推进明细 · Demo</span><h2>{project.name}</h2></div></div>{[["已完成","建立项目主档与责任人"],["进行中",project.next],["等待",project.milestone],["后续","进入卡面审批与生产准备"]].map(x=><div key={x[1]}><span>{x[0]}</span><b>{x[1]}</b></div>)}</section>}</>;
}

function Blueprint() {
  const modules=[{no:"01",title:"IP 与资源控制",status:"当前版本",copy:"合同、付款、人物、签名、发行项目形成统一经营视图。"},{no:"02",title:"供应链执行",status:"规划中",copy:"审批、供应商、生产批次、质检和入库沿用同一数据主线。"},{no:"03",title:"销售与渠道",status:"规划中",copy:"经销商、DTC、库存、折扣与项目损益形成闭环。"},{no:"04",title:"二级市场 FDE",status:"远期",copy:"成交价、流动性和收藏热度反哺 IP 与发行决策。"}];
  const secondarySkus=[
    {sku:"First Team 2026/27 基础盒",ip:"纽卡斯尔联",issue:"发售价 ¥199",market:"二级均价 ¥328 · 溢价 +65%",trend:"30 天 ↑12%",advice:"建议：下一批印量 +20%，补充常规流通量"},
    {sku:"Signatures 2026 限编 1/99",ip:"AC 米兰",issue:"发售价 ¥899",market:"二级均价 ¥1,560 · 溢价 +73%",trend:"30 天 ↑5%",advice:"建议：维持限编、提高配签比例，守住稀缺段"},
    {sku:"Cast Series 首批（待启动）",ip:"影视 IP·代号 PB",issue:"未定价",market:"无二级数据 · 参考同类影视 IP ±0–40%",trend:"—",advice:"建议：首版小批量 + 快反加印机制"},
  ];
  return <><PageHeader eyebrow="EXPANSION BLUEPRINT" title="一套跟着 IP 一起长大的经营系统" sub="人物、卡牌、项目与账目共用同一条数据主线；新场景上线即接入，不换系统、不重录数据。" />
  <section className="leverage-strip"><div><small>发行团队规模（公开参保人数）</small><b>15 人</b></div><div><small>在管国际 IP</small><b>10+</b></div><div><small>新增编制</small><b>0</b></div><p>AI 是经营杠杆：IP 越签越多、决策复杂度上升，组织不需要同步扩张——控制塔承接增量，不加人。</p></section>
  <section className="blueprint-flow">{modules.map((m,i)=><article className="module" key={m.no}><div><span>{m.no}</span><small>{m.status}</small></div><h2>{m.title}</h2><p>{m.copy}</p>{i<modules.length-1&&<b>→</b>}</article>)}</section><section className="data-thread"><p className="eyebrow">统一资产主线</p><h2>一张卡，从授权到二级市场</h2><div className="thread"><span>IP 权利</span><i>→</i><span>人物资源</span><i>→</i><span>发行项目</span><i>→</i><span>生产批次</span><i>→</i><span>销售渠道</span><i>→</i><span>市场表现</span></div><p>外部人物变动与二级市场数据，最终共同反哺下一轮 IP、人物、产品结构、发行量和定价决策。</p></section>
  <section className="panel secondary-panel">
    <div className="panel-head"><div><span>SECONDARY MARKET LOOP · 集团独有闭环 · 数据演示</span><h2>二级市场数据反哺发行决策</h2></div><em>卡淘成交价与流动性 → 印量 / 限编 / 定价</em></div>
    <div className="loop-flow"><span>卡淘成交与流动性</span><i>→</i><span>溢价率 / 转手率监测</span><i>→</i><span>下一批印量与限编建议</span><i>→</i><span>老板审批发行</span></div>
    <div className="sku-grid">{secondarySkus.map(s=><div className="sku-card" key={s.sku}><div className="sku-head"><b>{s.ip}</b><span>{s.sku}</span></div><dl><dt>发行端</dt><dd>{s.issue}</dd><dt>二级市场</dt><dd>{s.market}</dd><dt>走势</dt><dd>{s.trend}</dd></dl><p>{s.advice}</p></div>)}</div>
    <p className="loop-note">以上为推演示例：接入卡淘真实成交数据后，溢价率与流动性按周刷新，直接生成下一批印量、限编与定价建议——发行（达咖）与二级平台（卡淘）同集团才有的数据闭环。</p>
  </section></>;
}

function ImportDrawer({ type, onType, onClose, onImported }: { type: ImportType; onType: (t: ImportType) => void; onClose: () => void; onImported: (rows: ImportRow[]) => void }) {
  const [stage, setStage] = useState<ImportStage>("select"); const [file, setFile] = useState<File | null>(null); const [rows, setRows] = useState<ImportRow[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [receipt, setReceipt] = useState(""); const inputRef = useRef<HTMLInputElement>(null);
  const parseFile = async (selected: File) => { setError(""); setBusy(true); try { let parsed: ImportRow[] = []; const ext = selected.name.split(".").pop()?.toLowerCase(); if (ext === "json") { const value: unknown = JSON.parse(await selected.text()); if (!Array.isArray(value)) throw new Error("JSON 顶层必须是记录数组"); parsed = value.filter((x): x is ImportRow => typeof x === "object" && x !== null && !Array.isArray(x)); } else if (ext === "xlsx" || ext === "xls") { const XLSX = await import("xlsx"); const workbook = XLSX.read(await selected.arrayBuffer(), { type: "array", cellDates: true }); const firstSheet = workbook.Sheets[workbook.SheetNames[0]]; parsed = XLSX.utils.sheet_to_json<ImportRow>(firstSheet, { defval: "", raw: false }); } else { const text = await selected.text(); const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean); if (lines.length < 2) throw new Error("CSV 至少需要表头和一行数据"); const split = (line: string) => line.match(/("[^"]*(?:""[^"]*)*"|[^,]*)(?:,|$)/g)?.map(x => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) || []; const heads = split(lines[0]).map(x => x.trim()); parsed = lines.slice(1).map(line => Object.fromEntries(heads.map((h,i)=>[h, split(line)[i] ?? ""]))); } if (!parsed.length) throw new Error("文件中没有可导入记录"); if (parsed.length > 500) throw new Error("公开 Demo 单次最多导入 500 行"); setFile(selected); setRows(parsed); setStage("preview"); } catch (e) { setError(e instanceof Error ? e.message : "文件解析失败"); } finally { setBusy(false); } };
  const commit = async () => { if (!file) return; setBusy(true); setError(""); try { const form = new FormData(); form.append("file", file); form.append("type", type); form.append("rows", JSON.stringify(rows)); form.append("workspaceId", workspaceId()); const response = await fetch("/api/import", { method: "POST", body: form }); const data: { ok?: boolean; receipt?: string; error?: string } = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "导入失败"); setReceipt(data.receipt || "已完成"); onImported(rows); setStage("done"); } catch (e) { setError(e instanceof Error ? e.message : "导入失败"); } finally { setBusy(false); } };
  const required = type === "ip" ? ["name"] : ["ip", "amount", "date"]; const headers = rows[0] ? Object.keys(rows[0]).slice(0, 6) : []; const missing = required.filter(field => !headers.some(h => h.toLowerCase().includes(field)));
  const downloadTemplate=()=>{const csv=type==="ip"?"name,code,kind,contract,owner\n示例 IP,DEMO,体育,2026-2028,负责人":"ip,amount,date,category,status\n示例 IP,100000,2026-09-30,授权费,待审批";const url=URL.createObjectURL(new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=type==="ip"?"DAKA_IP导入模板.csv":"DAKA_账目导入模板.csv";a.click();URL.revokeObjectURL(url);};
  // The backdrop is intentionally mouse-only; all drawer controls remain keyboard accessible.
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  return <div className="drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><aside className="drawer import-drawer"><div className="drawer-head"><div><p className="eyebrow">DATA IMPORT</p><h2>{type === "ip" ? "导入新 IP" : "导入账目"}</h2></div><button onClick={onClose} aria-label="关闭">×</button></div><div className="stepper"><span className={stage!=="select"?"done":"active"}>1 选择文件</span><i /><span className={stage==="preview"?"active":stage==="done"?"done":""}>2 校验预览</span><i /><span className={stage==="done"?"active":""}>3 导入回执</span></div>{stage==="select"&&<><div className="type-switch"><button className={type==="ip"?"selected":""} onClick={()=>onType("ip")}>IP 主档</button><button className={type==="ledger"?"selected":""} onClick={()=>onType("ledger")}>账目</button></div><button className="drop-zone" onClick={()=>inputRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files?.[0];if(f)void parseFile(f);}} disabled={busy}><span>⇧</span><h3>{busy?"正在读取文件…":"选择或拖入数据文件"}</h3><p>支持 CSV、XLSX、XLS、JSON · 单次最多 500 行 / 5 MB</p></button><input ref={inputRef} hidden type="file" accept=".csv,.xlsx,.xls,.json" onChange={(e:ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0]; if(f) void parseFile(f);}}/><div className="template-box"><b>{type==="ip"?"IP 模板必填字段":"账目模板必填字段"}</b><code>{type==="ip"?"name, code, kind, contract, owner":"ip, amount, date, category, status"}</code><button onClick={downloadTemplate}>下载模板</button></div></>}{stage==="preview"&&<><div className="file-summary"><span className="file-icon">{file?.name.split(".").pop()?.toUpperCase()}</span><div><b>{file?.name}</b><small>{rows.length} 行 · {headers.length} 个已识别字段</small></div><button onClick={()=>setStage("select")}>更换文件</button></div><div className={`validation-banner ${missing.length?"warning":"success"}`}><b>{missing.length?"需要确认字段映射":"格式校验通过"}</b><span>{missing.length?`未自动识别：${missing.join("、")}；仍可作为演示数据导入。`:`${rows.length} 行可写入，未发现重复主键。`}</span></div><div className="preview-table"><div className="preview-row head">{headers.map(h=><span key={h}>{h}</span>)}</div>{rows.slice(0,5).map((row,i)=><div className="preview-row" key={i}>{headers.map(h=><span key={h}>{String(row[h] ?? "—")}</span>)}</div>)}</div><p className="preview-note">当前显示前 {Math.min(5,rows.length)} 行；确认后原始文件和逐行结果会写入审计回执。</p><button className="primary full large" disabled={busy} onClick={()=>void commit()}>{busy?"正在安全写入…":`确认导入 ${rows.length} 行`}</button></>}{stage==="done"&&<div className="receipt"><span>✓</span><p className="eyebrow">IMPORT COMPLETE</p><h2>数据已进入演示空间</h2><p>系统已保存原始文件、结构化记录与逐行审计结果。</p><dl><dt>回执编号</dt><dd>{receipt}</dd><dt>导入对象</dt><dd>{type==="ip"?"IP 主档":"账目"}</dd><dt>成功记录</dt><dd>{rows.length} 行</dd></dl><button className="primary full" onClick={onClose}>完成</button></div>}{error&&<div className="error-banner">{error}</div>}</aside></div>;
}

function AgentDrawer({ view, focus, draft, onClose }: { view: View; focus: string; draft: string; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([{role:"assistant",content:`我是 DAKA 经营 Agent。当前讨论上下文：${focus}。我会区分事实、假设与建议，并优先比较方案及其经营影响。`}]); const [input, setInput] = useState(draft); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const suggestions=["比较当前方案的收入、时间与风险","哪些假设尚未验证？","起草给版权方的预对账邮件","整理成 3 条老板汇报要点"];
  const submit = async (e?:FormEvent) => { e?.preventDefault(); const question=input.trim(); if(!question||busy)return; const next=[...messages,{role:"user" as const,content:question}]; setMessages(next); setInput(""); setBusy(true); setError(""); const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),30000); try{const response=await fetch("/api/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({messages:next,context:{view,focus,workspace:"公开演示空间",ipCount:3,alerts:2,next90DaysPayable:"199万元"}}),signal:controller.signal}); const data:{content?:string;error?:string}=await response.json(); if(!response.ok||!data.content)throw new Error(data.error||"Agent 暂时不可用"); setMessages(prev=>[...prev,{role:"assistant",content:data.content!}]);}catch(e){setError(e instanceof DOMException&&e.name==="AbortError"?"请求超过 30 秒，请稍后重试。":e instanceof Error?e.message:"Agent 请求失败");}finally{clearTimeout(timeout);setBusy(false);}};
  return <div className="drawer-backdrop"><aside className="drawer agent-drawer"><div className="drawer-head"><div><p className="eyebrow">GLM BUSINESS AGENT</p><h2><i className="online-dot" />经营分析助手</h2></div><button onClick={onClose} aria-label="关闭">×</button></div><div className="agent-context"><span>已读取</span><b>当前页面 · 3 个 IP · 5 项行动 · 3 条外部信号</b></div><div className="messages">{messages.map((m,i)=><div key={i} className={`message ${m.role}`}><small>{m.role==="assistant"?"DAKA AGENT":"你"}</small><p>{m.content}</p></div>)}{busy&&<div className="message assistant loading"><small>DAKA AGENT</small><p><i/><i/><i/></p></div>}</div><div className="suggestions compact"><b>快捷指令</b>{suggestions.map(s=><button key={s} onClick={()=>{setInput(s);inputRef.current?.focus();}}>{s}</button>)}</div>{error&&<div className="error-banner">{error}</div>}<form className="agent-input" onSubmit={submit}><textarea ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} placeholder="输入你的问题，或点上方快捷指令…" rows={3}/><div><span>答案由 GLM 生成，请核对重要经营事实</span><button disabled={!input.trim()||busy}>发送 ↑</button></div></form></aside></div>;
}

function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [saved,setSaved]=useState(false); const [temperature,setTemperature]=useState("0.3"); const [source,setSource]=useState("hybrid");
  useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose();};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[onClose]);
  // The backdrop is mouse-dismissable; the dialog itself has complete keyboard controls.
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  return <div className="drawer-backdrop settings-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><aside className="drawer settings-drawer" role="dialog" aria-modal="true" aria-label="系统设置"><div className="drawer-head"><div><p className="eyebrow">SETTINGS</p><h2>系统设置</h2></div><button onClick={onClose} aria-label="关闭设置">×</button></div><section className="settings-section"><span>Agent</span><h3>模型与回答偏好</h3><label>Agent 名称<input defaultValue="DAKA 经营 Agent" /></label><label>模型<input value="GLM-5.2 · Coding Plan" disabled readOnly/><small>智谱 Coding 专属端点 · 服务端安全调用</small></label><label>回答稳定度<select value={temperature} onChange={e=>setTemperature(e.target.value)}><option value="0.2">严谨 · 0.2</option><option value="0.3">平衡 · 0.3</option><option value="0.5">发散 · 0.5</option></select></label></section><section className="settings-section"><span>外部信号</span><h3>新闻与人物变动</h3><label>信号策略<select value={source} onChange={e=>setSource(e.target.value)}><option value="hybrid">官方源优先 + 新闻补充</option><option value="official">仅官方确认</option><option value="all">全部信号</option></select></label><div className="toggle-row"><div><b>需要人工确认</b><small>外部信号不得直接修改人物主档</small></div><input type="checkbox" defaultChecked /></div><div className="toggle-row"><div><b>每日经营摘要</b><small>每天 09:00 汇总高影响变化</small></div><input type="checkbox" defaultChecked /></div></section><section className="settings-section"><span>公开 Demo 安全</span><h3>数据与空间</h3><div className="security-row"><b>临时工作空间</b><em>已启用</em></div><div className="security-row"><b>单次导入限制</b><span>500 行 / 5 MB</span></div><div className="security-row"><b>敏感字段提醒</b><em>已启用</em></div></section><button className="primary full large" onClick={()=>{localStorage.setItem("daka_temperature",temperature);localStorage.setItem("daka_signal_source",source);setSaved(true);setTimeout(()=>setSaved(false),1800);}}>{saved?"✓ 设置已保存":"保存设置"}</button></aside></div>;
}

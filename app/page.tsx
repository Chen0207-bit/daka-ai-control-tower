"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";

type View = "actions" | "operations" | "portfolio" | "cash" | "signals" | "data" | "release" | "blueprint";
type ImportType = "ip" | "ledger";
type ImportStage = "select" | "preview" | "done";
type ChatMessage = { role: "user" | "assistant"; content: string };
type ImportRow = Record<string, string | number | boolean | null>;
type DecisionIssue = {
  id: string; level: "高" | "中"; title: string; summary: string; owner: string; due: string;
  state: string; impact: string; evidence: string[]; assumptions: string[];
  options: { name: string; result: string; time: string; cash: string; risk: string; recommended?: boolean }[];
};

const decisionIssues: DecisionIssue[] = [
  { id:"acm-signature", level:"高", title:"AC 米兰签名缺口可能影响限量系列发行", summary:"第二批签名仍缺 120 份。运营已完成代理催办，继续等待可能压缩设计与生产窗口。", owner:"发行运营 · 林乔", due:"今天 18:00", state:"等待老板决策", impact:"约 800 张产品 · 预计上市窗口 9 月下旬", evidence:["签名台账：目标 300，已收 180","代理回复：最快 9 月 18 日确认","供应商锁产窗口：9 月 22 日"], assumptions:["人物组合可在卡面终审前调整","拆批不会触发最低发行量条款"], options:[{name:"继续等待原签名",result:"保持原人物组合",time:"可能延迟 14 天",cash:"无新增成本",risk:"中高"},{name:"调整人物组合",result:"保住原发行窗口",time:"按期",cash:"预计影响收入 -3%",risk:"中",recommended:true},{name:"拆分两批发行",result:"首批按期上市",time:"延迟 3 天",cash:"增加成本 ¥8万",risk:"低"}] },
  { id:"nufc-payment", level:"高", title:"纽卡斯尔 122 万授权费需要付款取舍", summary:"按期付款有利于续约关系，但未来 90 天现金余量将接近内部安全线。", owner:"财务 · 王雯", due:"9 月 8 日", state:"等待财务确认", impact:"未来 90 天现金安全余量", evidence:["合同付款日：9 月 10 日","当前资料完整度：80%","验收确认仍缺 1 份"], assumptions:["分期需要版权方书面同意","AC 米兰新品预算保持不变"], options:[{name:"按期全额付款",result:"保障合同履约",time:"按期",cash:"支出 ¥122万",risk:"低"},{name:"申请两期支付",result:"保留新品预算",time:"需 3 天沟通",cash:"本期减少 ¥61万",risk:"中",recommended:true}] },
  { id:"pb-launch", level:"中", title:"《浴血黑帮》首批演员签名计划尚未启动", summary:"人物清单已建立，但优先级、代理联络和预算边界仍未确认。", owner:"IP 运营 · 周宁", due:"9 月 30 日", state:"运营可自行处理", impact:"首批产品立项与人物资源锁定", evidence:["已录入 21 位主要演员","尚无签名目标数量","预算待业务负责人确认"], assumptions:["首批产品聚焦 6–8 位核心人物"], options:[{name:"先锁定核心 6 人",result:"快速形成首发组合",time:"本周启动",cash:"预算可控",risk:"低",recommended:true},{name:"全名单同步询价",result:"获得完整成本视图",time:"增加 2 周",cash:"待报价",risk:"中"}] }
];

const baseIps = [
  { code: "ACM", name: "AC 米兰", kind: "足球俱乐部", contract: "2025–2027", health: 72, pay: "¥46万", stage: "发行中", risk: "1 项风险", tone: "milan" },
  { code: "NU", name: "纽卡斯尔联", kind: "足球俱乐部", contract: "2026–2028", health: 61, pay: "¥122万", stage: "筹备中", risk: "1 项风险", tone: "newcastle" },
  { code: "PB", name: "浴血黑帮", kind: "影视 IP", contract: "2026–2029", health: 30, pay: "—", stage: "待启动", risk: "需启动", tone: "peaky" },
];

const signals = [
  { date: "今天 08:40", level: "高", type: "阵容变动", person: "Rafael Leão", ip: "AC 米兰", headline: "外部信号：人物可能发生跨俱乐部变动", source: "示例新闻源 · 待人工确认", impact: "影响签名排期与卡面审批，关联 2026 限量签名系列", status: "待研判" },
  { date: "昨天 17:20", level: "中", type: "续约", person: "Anthony Gordon", ip: "纽卡斯尔联", headline: "俱乐部阵容合同状态出现更新", source: "示例结构化数据源", impact: "建议核对授权人物清单与下一季卡表", status: "已匹配" },
  { date: "08.23", level: "低", type: "新项目", person: "Cillian Murphy", ip: "浴血黑帮", headline: "人物近期公开活动热度上升", source: "示例媒体监测", impact: "可纳入首批演员签名优先级评估", status: "观察中" },
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
  { id: "portfolio", label: "IP 组合", icon: "◫" },
  { id: "cash", label: "账目与现金", icon: "¥" },
  { id: "signals", label: "IP 变动雷达", icon: "◎" },
  { id: "data", label: "数据中心", icon: "⇧" },
  { id: "release", label: "发行项目", icon: "◇" },
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
  const [view, setView] = useState<View>("actions");
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentFocus, setAgentFocus] = useState("当前经营全局");
  const [selectedDecisionId, setSelectedDecisionId] = useState(decisionIssues[0].id);
  const [approvedDecisions, setApprovedDecisions] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importType, setImportType] = useState<ImportType>("ip");
  const [importedIps, setImportedIps] = useState<typeof baseIps>([]);
  const [importedLedgers, setImportedLedgers] = useState<ImportRow[]>([]);
  const openImport = (type: ImportType) => { setImportType(type); setImportOpen(true); };
  const allIps = [...baseIps, ...importedIps];
  const openAgent = (focus: string) => { setAgentFocus(focus); setAgentOpen(true); };

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/data?workspaceId=${encodeURIComponent(workspaceId())}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("load failed"); return await response.json() as { ip?: ImportRow[]; ledger?: ImportRow[] }; })
      .then(data => { setImportedIps(rowsToIps(data.ip || [])); setImportedLedgers(data.ledger || []); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return <main className={`app-shell ${collapsed ? "is-collapsed" : ""}`}>
    <aside className="sidebar">
      <div className="brand"><span>D</span><strong>DAKA CONTROL</strong><button className="collapse-button" aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} onClick={() => setCollapsed(v => !v)}>{collapsed ? "›" : "‹"}</button></div>
      <div className="workspace-badge"><i>v1.1</i><span>决策闭环演示</span></div>
      <nav aria-label="主导航">{nav.map((item) => <button key={item.id} title={item.label} onClick={() => setView(item.id)} className={`nav-item ${view === item.id ? "active" : ""}`}><b>{item.icon}</b><span>{item.label}</span>{item.id === "signals" && <em>3</em>}</button>)}</nav>
      <div className="sidebar-bottom"><button className="agent-launch" onClick={() => openAgent("当前经营全局")}><span>✦</span><div><b>GLM 经营 Agent</b><small>讨论方案与经营影响</small></div></button><button className="settings-button" onClick={() => setSettingsOpen(true)}><span>⚙</span><div><b>设置</b><small>模型、数据源与偏好</small></div></button></div>
    </aside>
    <section className="workspace">
      <div className="utility-bar"><button className="mobile-menu" onClick={() => setCollapsed(v => !v)}>☰</button><div><span className="system-dot" />数据已同步 <b>2 分钟前</b></div><button className="quick-import" onClick={() => openImport("ip")}>＋ 导入数据</button><button className="avatar">FC</button></div>
      {view === "actions" && <BossControl selectedId={selectedDecisionId} approved={approvedDecisions} onSelect={setSelectedDecisionId} onApprove={id => setApprovedDecisions(prev => prev.includes(id) ? prev : [...prev,id])} onAsk={openAgent} onOperations={() => setView("operations")} />}
      {view === "operations" && <OperationsWorkbench approved={approvedDecisions} onEscalate={(id) => { setSelectedDecisionId(id); setView("actions"); }} onAsk={openAgent} />}
      {view === "portfolio" && <Portfolio ips={allIps} onImport={() => openImport("ip")} onOpenIP={() => setView("release")} />}
      {view === "cash" && <CashDashboard onImport={() => openImport("ledger")} importedRows={importedLedgers} />}
      {view === "signals" && <SignalRadar onAsk={() => openAgent("Rafael Leão 外部变动及其发行影响")} />}
      {view === "data" && <DataCenter onImport={openImport} />}
      {view === "release" && <Release onBlueprint={() => setView("blueprint")} />}
      {view === "blueprint" && <Blueprint />}
      <footer>DAKA AI 经营控制塔 · 新闻与经营数字均明确标记演示属性，不构成真实业务事实</footer>
    </section>
    {importOpen && <ImportDrawer type={importType} onType={setImportType} onClose={() => setImportOpen(false)} onImported={(rows) => { if (importType === "ip") setImportedIps(prev => [...prev, ...rowsToIps(rows, Math.max(0, 20 - allIps.length))]); else setImportedLedgers(prev => [...prev, ...rows]); }} />}
    {agentOpen && <AgentDrawer view={view} focus={agentFocus} onClose={() => setAgentOpen(false)} />}
    {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
  </main>;
}

function PageHeader({ eyebrow, title, sub, actions }: { eyebrow: string; title: string; sub: string; actions?: React.ReactNode }) {
  return <header className="topbar"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="subtitle">{sub}</p></div><div className="topbar-actions">{actions}<div className="demo-chip"><i />公开演示空间</div></div></header>;
}

function BossControl({ selectedId, approved, onSelect, onApprove, onAsk, onOperations }: { selectedId:string; approved:string[]; onSelect:(id:string)=>void; onApprove:(id:string)=>void; onAsk:(focus:string)=>void; onOperations:()=>void }) {
  const item = decisionIssues.find(issue => issue.id === selectedId) || decisionIssues[0];
  const done = approved.includes(item.id);
  return <><PageHeader eyebrow="老板经营总控 · DECISION CONTROL" title="今天有 2 项需要你拍板" sub="AI 与团队已处理日常跟进；这里只保留影响收入、现金、交期或品牌的例外事项。" actions={<button className="role-jump" onClick={onOperations}>切换到运营工作台 →</button>} />
    <div className="decision-metrics"><article><small>需要老板决定</small><strong>{Math.max(0,2-approved.length)}</strong><p>1 项今天到期</p></article><article><small>已授权团队处理</small><strong>{7+approved.length}</strong><p>AI 持续追踪</p></article><article><small>等待外部确认</small><strong>4</strong><p>无需现在介入</p></article><article className="ai-proof"><small>本周 AI 已代办</small><strong>26</strong><p>预计节省 11.5 小时</p></article></div>
    <div className="decision-layout"><section className="panel decision-inbox"><div className="panel-head"><div><span>DECISION INBOX</span><h2>需要介入的经营事项</h2></div><em>按经营影响排序</em></div>{decisionIssues.map(issue=><button key={issue.id} className={`decision-row ${selectedId===issue.id?"selected":""}`} onClick={()=>onSelect(issue.id)}><span className={`decision-level level-${issue.level}`}>{issue.level}</span><div><small>{approved.includes(issue.id)?"已完成决策":issue.state} · {issue.due}</small><h3>{issue.title}</h3><p>{issue.impact}</p></div><b>{approved.includes(issue.id)?"✓":"→"}</b></button>)}</section>
      <section className="panel decision-detail"><div className="decision-title"><div><span className={`decision-level level-${item.level}`}>{item.level}影响</span><small>{done?"已批准并返回运营执行":item.state}</small></div><h2>{item.title}</h2><p>{item.summary}</p></div><div className="decision-owner"><span>当前责任人</span><b>{item.owner}</b><span>必须处理</span><b>{item.due}</b></div><div className="decision-tabs"><span>方案比较</span><span>依据 {item.evidence.length}</span><span>假设 {item.assumptions.length}</span></div><div className="option-grid">{item.options.map(option=><article key={option.name} className={option.recommended?"recommended":""}>{option.recommended&&<em>AI + 运营推荐</em>}<h3>{option.name}</h3><p>{option.result}</p><dl><dt>上市时间</dt><dd>{option.time}</dd><dt>现金 / 收入</dt><dd>{option.cash}</dd><dt>风险</dt><dd>{option.risk}</dd></dl></article>)}</div><details className="decision-evidence"><summary>查看判断依据与关键假设</summary><div><section><b>已确认依据</b>{item.evidence.map(x=><p key={x}>✓ {x}</p>)}</section><section><b>仍需验证的假设</b>{item.assumptions.map(x=><p key={x}>△ {x}</p>)}</section></div></details><div className="decision-actions"><button onClick={()=>onAsk(`${item.title}：请比较当前方案并解释关键假设`)}>与 Agent 讨论方案</button><button className="primary" disabled={done} onClick={()=>onApprove(item.id)}>{done?"✓ 已生成运营行动":"批准推荐方案"}</button></div></section></div></>;
}

function OperationsWorkbench({ approved, onEscalate, onAsk }: { approved:string[]; onEscalate:(id:string)=>void; onAsk:(focus:string)=>void }) {
  const acApproved = approved.includes("acm-signature");
  return <><PageHeader eyebrow="发行运营 · AI WORKBENCH" title="AI 已完成初步处理，等待你确认 4 项" sub="运营处理事实核对、日常推进与升级；超过权限阈值的事项才进入老板决策收件箱。" actions={<div className="operator-chip"><span>LQ</span><div><b>林乔</b><small>发行运营负责人</small></div></div>} />
    <div className="ops-stats"><article><span>AI 已完成，待确认</span><b>4</b></article><article><span>需要补充信息</span><b>3</b></article><article><span>需要升级老板</span><b>{acApproved?1:2}</b></article><article><span>今日已自动推进</span><b>12</b></article></div>
    <div className="ops-layout"><section className="panel ops-queue"><div className="panel-head"><div><span>AI REVIEW QUEUE</span><h2>等待运营确认</h2></div><button>筛选：全部</button></div>
      <article className="ops-item urgent"><div className="ops-item-top"><span>需要升级老板</span><small>8 分钟前</small></div><h3>AC 米兰第二批签名缺口 120 份</h3><p>AI 已核对签名台账、代理回复和供应商锁产时间，判断超出运营可调整范围。</p><div className="ai-worklog"><b>✦ AI 已完成</b><span>核对 6 位人物进度</span><span>匹配 1 个在途项目</span><span>生成 3 套方案</span></div><div className="ops-buttons"><button onClick={()=>onAsk("AC 米兰签名缺口：帮助运营检查升级材料是否完整")}>检查 AI 依据</button><button className="primary" onClick={()=>onEscalate("acm-signature")}>{acApproved?"查看老板决定":"升级老板决策"}</button></div></article>
      <article className="ops-item"><div className="ops-item-top"><span className="auto">可由运营确认</span><small>21 分钟前</small></div><h3>浴血黑帮首批演员联络顺序</h3><p>AI 建议先锁定 6 位核心人物，并已按角色重要度与公开热度生成联络顺序。</p><div className="ai-worklog"><b>✦ AI 已完成</b><span>整理 21 位演员</span><span>标记 6 位核心人物</span><span>起草代理询价邮件</span></div><div className="ops-buttons"><button>查看草稿</button><button className="primary">确认并发送</button></div></article>
      <article className="ops-item"><div className="ops-item-top"><span className="missing">缺少信息</span><small>今天 09:10</small></div><h3>AC 米兰第三批资源验收</h3><p>系统缺少验收负责人，无法自动创建 10 月 15 日检查点。</p><div className="ops-buttons"><button>补充负责人</button><button>暂缓处理</button></div></article></section>
      <aside className="ops-side"><section className="panel"><div className="panel-head"><div><span>AGENT ACTIVITY</span><h2>AI 今天替你做了什么</h2></div></div>{[["09:42","核对 AC 米兰签名台账","6 人"],["09:31","匹配外部人物变化","3 条"],["09:18","提取合同付款节点","2 项"],["08:55","生成催办邮件草稿","4 封"]].map(x=><div className="activity-row" key={x[0]}><time>{x[0]}</time><div><b>{x[1]}</b><small>{x[2]}</small></div><span>✓</span></div>)}</section><section className="panel boundary-card"><p className="eyebrow">DECISION RIGHTS</p><h2>什么情况必须升级？</h2><ul><li>影响发行日期超过 7 天</li><li>新增成本超过 ¥5 万</li><li>变更核心人物或产品定位</li><li>付款与合同条款发生变化</li></ul><button onClick={()=>onAsk("请解释当前运营升级老板的决策权限规则")}>让 Agent 解释边界 →</button></section></aside></div></>;
}

function Portfolio({ ips, onImport, onOpenIP }: { ips: typeof baseIps; onImport: () => void; onOpenIP: () => void }) {
  return <><PageHeader eyebrow="IP PORTFOLIO" title="现有 IP 组合，一眼看到风险与下一步" sub="当前展示真实业务样例；数据结构可支撑 20 个 IP，不再展示空占位符。" actions={<button className="primary" onClick={onImport}>＋ 导入新 IP</button>} /><div className="filter-row"><button className="selected">全部 {ips.length}</button><button>有风险 2</button><button>90 天内付款 2</button><button>待启动 1</button><span>容量 {ips.length} / 20</span></div><section className="portfolio-grid">{ips.map(ip => <button className="ip-card" key={`${ip.code}-${ip.name}`} onClick={ip.code === "ACM" ? onOpenIP : undefined}><div className={`ip-mark ${ip.tone}`}>{ip.code}</div><div className="ip-card-head"><div><h2>{ip.name}</h2><p>{ip.kind} · {ip.contract}</p></div><span>{ip.stage}</span></div><div className="health"><div><small>资源健康度</small><b>{ip.health}%</b></div><i><em style={{width:`${Math.min(100, ip.health)}%`}} /></i></div><div className="ip-facts"><div><small>近期付款</small><b>{ip.pay}</b></div><div><small>当前提醒</small><b>{ip.risk}</b></div></div></button>)}</section></>;
}

function CashDashboard({ onImport, importedRows }: { onImport: () => void; importedRows: ImportRow[] }) {
  const importedWan = importedRows.reduce((sum, row) => sum + (Number(String(row.amount || row.金额 || 0).replace(/[^0-9.-]/g, "")) || 0), 0) / 10_000;
  const months = [{m:"9月",v:Math.round(168 + importedWan),p:Math.min(100, 92 + importedWan / 5)},{m:"10月",v:46,p:28},{m:"11月",v:78,p:44},{m:"12月",v:24,p:16},{m:"1月",v:112,p:64},{m:"2月",v:58,p:34}];
  return <><PageHeader eyebrow="CASH & OBLIGATIONS" title="账目不是流水，是未来经营动作" sub="把合同付款义务、已付账目和发行节点放在同一条时间线上。" actions={<button className="primary" onClick={onImport}>＋ 导入账目</button>} /><div className="summary-grid cash-summary"><article className="summary dark"><small>未来 180 天应付</small><strong>¥486万</strong><p>已覆盖 3 个 IP</p></article><article className="summary"><small>本月已支付</small><strong>¥74万</strong><p>较计划少 ¥12万</p></article><article className="summary"><small>待审批</small><strong>¥122万</strong><p>纽卡斯尔授权费</p></article><article className="summary risk"><small>逾期风险</small><strong>1 项</strong><p>需在 9 月 10 日前处理</p></article></div><div className="dashboard-grid"><section className="panel chart-panel"><div className="panel-head"><div><span>未来 6 个月</span><h2>付款压力分布</h2></div><b>单位：万元</b></div><div className="bar-chart">{months.map(x => <div className="bar-col" key={x.m}><span>{x.v}</span><i style={{height:`${x.p}%`}} /><small>{x.m}</small></div>)}</div></section><section className="panel"><div className="panel-head"><div><span>按 IP 聚合</span><h2>预算占用</h2></div></div><div className="donut-wrap"><div className="donut"><b>¥486万</b><small>应付总额</small></div><ul className="legend"><li><i className="milan-dot" />纽卡斯尔联 <b>42%</b></li><li><i className="blue-dot" />AC 米兰 <b>37%</b></li><li><i className="amber-dot" />浴血黑帮 <b>21%</b></li></ul></div></section></div><section className="panel ledger-table"><div className="panel-head"><div><span>付款台账</span><h2>近期义务</h2></div><button>导出 CSV</button></div><div className="ledger-row head"><span>到期日</span><span>IP / 合同</span><span>项目</span><span>金额</span><span>状态</span></div>{[["2026.09.10","纽卡斯尔联","年度授权费","¥1,220,000","待审批"],["2026.10.15","AC 米兰","人物资源第三批","¥460,000","待付款"],["2026.11.30","浴血黑帮","首批演员资源","¥780,000","预算中"]].map((r,i)=><div className="ledger-row" key={i}>{r.map((c,j)=><span key={j} className={j===4?"state-pill":""}>{c}</span>)}</div>)}</section></>;
}

function SignalRadar({ onAsk }: { onAsk: () => void }) {
  const [selected, setSelected] = useState(0); const item = signals[selected];
  return <><PageHeader eyebrow="IP CHANGE RADAR" title="外部世界发生变化，系统告诉你影响什么" sub="事实来源、人物匹配和经营影响分层呈现；未经确认的新闻不会修改主数据。" /><div className="summary-grid signal-summary"><article className="summary dark"><small>过去 7 天信号</small><strong>18</strong><p>覆盖当前 3 个 IP</p></article><article className="summary"><small>高影响</small><strong>3</strong><p>需要今天研判</p></article><article className="summary"><small>已自动匹配</small><strong>89%</strong><p>2 条待人工确认</p></article><article className="summary"><small>可能影响发行</small><strong>2</strong><p>关联 3 个在途项目</p></article></div><div className="radar-layout"><section className="panel radar-list"><div className="panel-head"><div><span>信号流</span><h2>与当前 IP 相关</h2></div><button>数据源设置</button></div>{signals.map((s,i)=><button className={`radar-item ${selected===i?"selected":""}`} key={s.person} onClick={()=>setSelected(i)}><span className={`impact-dot ${s.level}`}>{s.level}</span><div><small>{s.date} · {s.type}</small><h3>{s.headline}</h3><p>{s.person} · {s.ip}</p></div><em>{s.status}</em></button>)}</section><aside className="panel signal-detail"><div className="detail-kicker"><span className="status red">{item.level}影响</span><small>{item.status}</small></div><h2>{item.person}</h2><p className="headline">{item.headline}</p><dl><dt>关联 IP</dt><dd>{item.ip}</dd><dt>来源与可信度</dt><dd>{item.source}</dd><dt>系统匹配依据</dt><dd>英文名 + 当前俱乐部 + 人物主档</dd><dt>可能的经营影响</dt><dd>{item.impact}</dd></dl><div className="guardrail">只有“官方确认”或“人工确认”后，系统才会创建新的任职关系记录；历史关系不会被覆盖。</div><button className="primary full" onClick={onAsk}>让 Agent 分析应对动作</button></aside></div></>;
}

function DataCenter({ onImport }: { onImport: (type: ImportType) => void }) {
  return <><PageHeader eyebrow="DATA CENTER" title="把代理手里的表，变成公司的经营数据" sub="每次导入都有校验、差异、回执与审计记录，可追溯到原始文件。" /><section className="import-cards"><button onClick={()=>onImport("ip")}><span>IP</span><div><h2>导入 IP 主档</h2><p>名称、类型、合同周期、负责人及经营状态</p></div><b>开始导入 →</b></button><button onClick={()=>onImport("ledger")}><span>¥</span><div><h2>导入账目</h2><p>应收应付、合同义务、发生日期、金额及状态</p></div><b>开始导入 →</b></button><button className="disabled"><span>▤</span><div><h2>合同与签名台账</h2><p>下一阶段支持 PDF 提取与人物资源批量录入</p></div><b>即将开放</b></button></section><div className="data-grid"><section className="panel quality-panel"><div className="panel-head"><div><span>数据质量</span><h2>当前主数据健康度</h2></div><strong>82%</strong></div>{[["IP 基础信息","100%"],["合同与付款字段","78%"],["人物实体匹配","86%"],["签名资源台账","64%"]].map(x=><div className="quality-row" key={x[0]}><span>{x[0]}</span><i><em style={{width:x[1]}} /></i><b>{x[1]}</b></div>)}</section><section className="panel import-history"><div className="panel-head"><div><span>导入任务</span><h2>最近记录</h2></div><button>查看全部</button></div>{[["ACM_球员名单_2026.xlsx","人物资源","126 行","已完成"],["Q3_授权费台账.csv","账目","18 行","已完成"],["PB_演员清单.xlsx","人物资源","21 行","3 条待确认"]].map((x,i)=><div className="history-row" key={i}><span className="file-icon">{i===1?"CSV":"XLS"}</span><div><b>{x[0]}</b><small>{x[1]} · {x[2]}</small></div><em>{x[3]}</em></div>)}</section></div><section className="panel audit-panel"><div><p className="eyebrow">完整审计链</p><h2>知道谁、在什么时候、从哪份文件改了什么</h2><p>原始文件保存到对象存储，结构化记录进入数据库；每一行都保留来源行号与字段差异。</p></div><div className="audit-flow"><span>原始文件</span><i>→</i><span>字段映射</span><i>→</i><span>数据校验</span><i>→</i><span>确认入库</span><i>→</i><span>审计回执</span></div></section></>;
}

function Release({ onBlueprint }: { onBlueprint: () => void }) {
  const stages = [{name:"资源确认",done:true},{name:"卡表设计",done:true},{name:"授权审批",done:false},{name:"生产准备",done:false},{name:"上市",done:false}];
  return <><PageHeader eyebrow="RELEASE CONTROL" title="AC Milan Signatures 2026" sub="签名资源直接决定卡表、稀缺度、发行量和上市时间。" /><section className="release-hero"><div><span className="status amber">存在风险</span><h2>计划发行 5,000 张</h2><p>当前可确认资源支持约 4,200 张，剩余 800 张取决于第二批签名交付。</p></div><div className="release-number"><small>发行准备度</small><strong>64%</strong></div></section><section className="stage-line">{stages.map((s,i)=><div className={s.done?"stage done":"stage"} key={s.name}><i>{s.done?"✓":i+1}</i><span>{s.name}</span></div>)}</section><div className="detail-grid"><section className="panel roster-panel"><div className="panel-head"><div><span>人物与签名供给</span><h2>核心人物资源</h2></div></div><div className="player-table"><div className="player-row table-head"><span>人物</span><span>年度计划</span><span>已获取</span><span>下一批</span><span>状态</span></div>{acPlayers.map(p=><div className="player-row" key={p.name}><div><b>{p.name}</b><small>{p.cn} · {p.role}</small></div><span>{p.target}</span><span>{p.got}<i className="mini-track"><em style={{width:`${Math.round(p.got/p.target*100)}%`}} /></i></span><span>{p.next}</span><span className={p.state==="需跟进"?"text-risk":"text-good"}>{p.state}</span></div>)}</div></section><aside className="panel future-hook"><p className="eyebrow">下一阶段连接点</p><h2>同一个项目继续进入供应链</h2><p>审批完成后继续追踪供应商、生产批次、限量序列号、抽检记录和入库数量。</p><button className="primary full" onClick={onBlueprint}>查看能力蓝图</button></aside></div></>;
}

function Blueprint() {
  const modules=[{no:"01",title:"IP 与资源控制",status:"当前 Demo",copy:"合同、付款、人物、签名、发行项目形成统一经营视图。"},{no:"02",title:"供应链执行",status:"下一阶段",copy:"审批、供应商、生产批次、质检和入库沿用同一数据主线。"},{no:"03",title:"销售与渠道",status:"后续接入",copy:"经销商、DTC、库存、折扣与项目损益形成闭环。"},{no:"04",title:"二级市场 FDE",status:"未来能力",copy:"成交价、流动性和收藏热度反哺 IP 与发行决策。"}];
  return <><PageHeader eyebrow="EXPANSION BLUEPRINT" title="敲门砖之后，是一套可生长的经营系统" sub="第一阶段先让老板掌控 IP；后续模块沿统一的人物、卡牌、项目与账目数据继续扩展。" /><section className="blueprint-flow">{modules.map((m,i)=><article className="module" key={m.no}><div><span>{m.no}</span><small>{m.status}</small></div><h2>{m.title}</h2><p>{m.copy}</p>{i<modules.length-1&&<b>→</b>}</article>)}</section><section className="data-thread"><p className="eyebrow">统一资产主线</p><h2>一张卡，从授权到二级市场</h2><div className="thread"><span>IP 权利</span><i>→</i><span>人物资源</span><i>→</i><span>发行项目</span><i>→</i><span>生产批次</span><i>→</i><span>销售渠道</span><i>→</i><span>市场表现</span></div><p>外部人物变动与二级市场数据，最终共同反哺下一轮 IP、人物、产品结构、发行量和定价决策。</p></section></>;
}

function ImportDrawer({ type, onType, onClose, onImported }: { type: ImportType; onType: (t: ImportType) => void; onClose: () => void; onImported: (rows: ImportRow[]) => void }) {
  const [stage, setStage] = useState<ImportStage>("select"); const [file, setFile] = useState<File | null>(null); const [rows, setRows] = useState<ImportRow[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [receipt, setReceipt] = useState(""); const inputRef = useRef<HTMLInputElement>(null);
  const parseFile = async (selected: File) => { setError(""); setBusy(true); try { let parsed: ImportRow[] = []; const ext = selected.name.split(".").pop()?.toLowerCase(); if (ext === "json") { const value: unknown = JSON.parse(await selected.text()); if (!Array.isArray(value)) throw new Error("JSON 顶层必须是记录数组"); parsed = value.filter((x): x is ImportRow => typeof x === "object" && x !== null && !Array.isArray(x)); } else if (ext === "xlsx" || ext === "xls") { const XLSX = await import("xlsx"); const workbook = XLSX.read(await selected.arrayBuffer(), { type: "array", cellDates: true }); const firstSheet = workbook.Sheets[workbook.SheetNames[0]]; parsed = XLSX.utils.sheet_to_json<ImportRow>(firstSheet, { defval: "", raw: false }); } else { const text = await selected.text(); const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean); if (lines.length < 2) throw new Error("CSV 至少需要表头和一行数据"); const split = (line: string) => line.match(/("[^"]*(?:""[^"]*)*"|[^,]*)(?:,|$)/g)?.map(x => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) || []; const heads = split(lines[0]).map(x => x.trim()); parsed = lines.slice(1).map(line => Object.fromEntries(heads.map((h,i)=>[h, split(line)[i] ?? ""]))); } if (!parsed.length) throw new Error("文件中没有可导入记录"); if (parsed.length > 500) throw new Error("公开 Demo 单次最多导入 500 行"); setFile(selected); setRows(parsed); setStage("preview"); } catch (e) { setError(e instanceof Error ? e.message : "文件解析失败"); } finally { setBusy(false); } };
  const commit = async () => { if (!file) return; setBusy(true); setError(""); try { const form = new FormData(); form.append("file", file); form.append("type", type); form.append("rows", JSON.stringify(rows)); form.append("workspaceId", workspaceId()); const response = await fetch("/api/import", { method: "POST", body: form }); const data: { ok?: boolean; receipt?: string; error?: string } = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "导入失败"); setReceipt(data.receipt || "已完成"); onImported(rows); setStage("done"); } catch (e) { setError(e instanceof Error ? e.message : "导入失败"); } finally { setBusy(false); } };
  const required = type === "ip" ? ["name"] : ["ip", "amount", "date"]; const headers = rows[0] ? Object.keys(rows[0]).slice(0, 6) : []; const missing = required.filter(field => !headers.some(h => h.toLowerCase().includes(field)));
  // The backdrop is intentionally mouse-only; all drawer controls remain keyboard accessible.
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  return <div className="drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><aside className="drawer import-drawer"><div className="drawer-head"><div><p className="eyebrow">DATA IMPORT</p><h2>{type === "ip" ? "导入新 IP" : "导入账目"}</h2></div><button onClick={onClose} aria-label="关闭">×</button></div><div className="stepper"><span className={stage!=="select"?"done":"active"}>1 选择文件</span><i /><span className={stage==="preview"?"active":stage==="done"?"done":""}>2 校验预览</span><i /><span className={stage==="done"?"active":""}>3 导入回执</span></div>{stage==="select"&&<><div className="type-switch"><button className={type==="ip"?"selected":""} onClick={()=>onType("ip")}>IP 主档</button><button className={type==="ledger"?"selected":""} onClick={()=>onType("ledger")}>账目</button></div><button className="drop-zone" onClick={()=>inputRef.current?.click()} disabled={busy}><span>⇧</span><h3>{busy?"正在读取文件…":"选择或拖入数据文件"}</h3><p>支持 CSV、XLSX、XLS、JSON · 单次最多 500 行 / 5 MB</p></button><input ref={inputRef} hidden type="file" accept=".csv,.xlsx,.xls,.json" onChange={(e:ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0]; if(f) void parseFile(f);}}/><div className="template-box"><b>{type==="ip"?"IP 模板必填字段":"账目模板必填字段"}</b><code>{type==="ip"?"name, code, kind, contract, owner":"ip, amount, date, category, status"}</code><button>下载模板</button></div></>}{stage==="preview"&&<><div className="file-summary"><span className="file-icon">{file?.name.split(".").pop()?.toUpperCase()}</span><div><b>{file?.name}</b><small>{rows.length} 行 · {headers.length} 个已识别字段</small></div><button onClick={()=>setStage("select")}>更换文件</button></div><div className={`validation-banner ${missing.length?"warning":"success"}`}><b>{missing.length?"需要确认字段映射":"格式校验通过"}</b><span>{missing.length?`未自动识别：${missing.join("、")}；仍可作为演示数据导入。`:`${rows.length} 行可写入，未发现重复主键。`}</span></div><div className="preview-table"><div className="preview-row head">{headers.map(h=><span key={h}>{h}</span>)}</div>{rows.slice(0,5).map((row,i)=><div className="preview-row" key={i}>{headers.map(h=><span key={h}>{String(row[h] ?? "—")}</span>)}</div>)}</div><p className="preview-note">当前显示前 {Math.min(5,rows.length)} 行；确认后原始文件和逐行结果会写入审计回执。</p><button className="primary full large" disabled={busy} onClick={()=>void commit()}>{busy?"正在安全写入…":`确认导入 ${rows.length} 行`}</button></>}{stage==="done"&&<div className="receipt"><span>✓</span><p className="eyebrow">IMPORT COMPLETE</p><h2>数据已进入演示空间</h2><p>系统已保存原始文件、结构化记录与逐行审计结果。</p><dl><dt>回执编号</dt><dd>{receipt}</dd><dt>导入对象</dt><dd>{type==="ip"?"IP 主档":"账目"}</dd><dt>成功记录</dt><dd>{rows.length} 行</dd></dl><button className="primary full" onClick={onClose}>完成</button></div>}{error&&<div className="error-banner">{error}</div>}</aside></div>;
}

function AgentDrawer({ view, focus, onClose }: { view: View; focus: string; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([{role:"assistant",content:`我是 DAKA 经营 Agent。当前讨论上下文：${focus}。我会区分事实、假设与建议，并优先比较方案及其经营影响。`}]); const [input, setInput] = useState(""); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const suggestions=["比较当前方案的收入、时间与风险","哪些假设尚未验证？","批准后应生成哪些行动？"];
  const submit = async (e?:FormEvent) => { e?.preventDefault(); const question=input.trim(); if(!question||busy)return; const next=[...messages,{role:"user" as const,content:question}]; setMessages(next); setInput(""); setBusy(true); setError(""); const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),30000); try{const response=await fetch("/api/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({messages:next,context:{view,focus,workspace:"公开演示空间",ipCount:3,alerts:2,next90DaysPayable:"168万元"}}),signal:controller.signal}); const data:{content?:string;error?:string}=await response.json(); if(!response.ok||!data.content)throw new Error(data.error||"Agent 暂时不可用"); setMessages(prev=>[...prev,{role:"assistant",content:data.content!}]);}catch(e){setError(e instanceof DOMException&&e.name==="AbortError"?"请求超过 30 秒，请稍后重试。":e instanceof Error?e.message:"Agent 请求失败");}finally{clearTimeout(timeout);setBusy(false);}};
  return <div className="drawer-backdrop"><aside className="drawer agent-drawer"><div className="drawer-head"><div><p className="eyebrow">GLM BUSINESS AGENT</p><h2><i className="online-dot" />经营分析助手</h2></div><button onClick={onClose} aria-label="关闭">×</button></div><div className="agent-context"><span>已读取</span><b>当前页面 · 3 个 IP · 5 项行动 · 3 条外部信号</b></div><div className="messages">{messages.map((m,i)=><div key={i} className={`message ${m.role}`}><small>{m.role==="assistant"?"DAKA AGENT":"你"}</small><p>{m.content}</p></div>)}{busy&&<div className="message assistant loading"><small>DAKA AGENT</small><p><i/><i/><i/></p></div>}</div>{messages.length===1&&<div className="suggestions">{suggestions.map(s=><button key={s} onClick={()=>setInput(s)}>{s}</button>)}</div>}{error&&<div className="error-banner">{error}</div>}<form className="agent-input" onSubmit={submit}><textarea value={input} onChange={e=>setInput(e.target.value)} placeholder="询问风险、付款、人物变动或发行影响…" rows={3}/><div><span>答案由 GLM 生成，请核对重要经营事实</span><button disabled={!input.trim()||busy}>发送 ↑</button></div></form></aside></div>;
}

function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [saved,setSaved]=useState(false); const [temperature,setTemperature]=useState("0.3"); const [source,setSource]=useState("hybrid");
  return <div className="drawer-backdrop"><aside className="drawer settings-drawer"><div className="drawer-head"><div><p className="eyebrow">SETTINGS</p><h2>系统设置</h2></div><button onClick={onClose} aria-label="关闭">×</button></div><section className="settings-section"><span>Agent</span><h3>模型与回答偏好</h3><label>Agent 名称<input defaultValue="DAKA 经营 Agent" /></label><label>模型<input value="GLM-5.2 · Coding Plan" disabled readOnly/><small>智谱 Coding 专属端点 · 服务端安全调用</small></label><label>回答稳定度<select value={temperature} onChange={e=>setTemperature(e.target.value)}><option value="0.2">严谨 · 0.2</option><option value="0.3">平衡 · 0.3</option><option value="0.5">发散 · 0.5</option></select></label></section><section className="settings-section"><span>外部信号</span><h3>新闻与人物变动</h3><label>信号策略<select value={source} onChange={e=>setSource(e.target.value)}><option value="hybrid">官方源优先 + 新闻补充</option><option value="official">仅官方确认</option><option value="all">全部信号</option></select></label><div className="toggle-row"><div><b>需要人工确认</b><small>外部信号不得直接修改人物主档</small></div><input type="checkbox" defaultChecked /></div><div className="toggle-row"><div><b>每日经营摘要</b><small>每天 09:00 汇总高影响变化</small></div><input type="checkbox" defaultChecked /></div></section><section className="settings-section"><span>公开 Demo 安全</span><h3>数据与空间</h3><div className="security-row"><b>临时工作空间</b><em>已启用</em></div><div className="security-row"><b>单次导入限制</b><span>500 行 / 5 MB</span></div><div className="security-row"><b>敏感字段提醒</b><em>已启用</em></div></section><button className="primary full large" onClick={()=>{localStorage.setItem("daka_temperature",temperature);localStorage.setItem("daka_signal_source",source);setSaved(true);setTimeout(()=>setSaved(false),1800);}}>{saved?"✓ 设置已保存":"保存设置"}</button></aside></div>;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(projectRoot, "popup", "popup.html");
const cssPath = path.join(projectRoot, "popup", "popup.css");
const css = fs.readFileSync(cssPath, "utf8");
const sourceHtml = fs.readFileSync(htmlPath, "utf8");
const baseCommands = [
  "document.querySelector('#statusBadge').className='status running';",
  "document.querySelector('#statusBadge').innerHTML='<i></i>运行中';",
  "document.querySelector('#powerLabel').textContent='已启用';",
  "document.querySelector('#toggleEnabled').classList.add('enabled');",
  "document.querySelector('#toggleEnabled').setAttribute('aria-checked','true');",
  "document.querySelector('#siteCount').textContent='3';",
  "document.querySelector('#interval').textContent='10m';",
  "document.querySelector('#activeCount').textContent='0';",
  "document.querySelector('#logCount').textContent='3';",
  "const sites=[['gitlab.example.com','https://gitlab.example.com'],['jira.example.com','https://jira.example.com'],['docs.example.com','https://docs.example.com']];",
  "document.querySelector('#siteList').innerHTML=sites.map(function(site){return '<li><span class=\\\"site-dot\\\"></span><div><strong>'+site[0]+'</strong><small>'+site[1]+'</small></div></li>';}).join('');"
];

const viewCommands = {
  control: [],
  settings: [
    "document.querySelector('#intervalMinutes').value='10';",
    "document.querySelector('#pageWaitSeconds').value='10';",
    "document.querySelector('#maxConcurrentTabs').value='3';",
    "document.querySelector('#blacklist').value='analytics.example.com\\ngoogle.com';",
    "document.querySelector('#whitelistEnabled').checked=true;",
    "document.querySelector('#whitelist').disabled=false;",
    "document.querySelector('#whitelist').value='gitlab.example.com\\njira.example.com\\ndocs.example.com';",
    "document.querySelector('.whitelist-field').classList.remove('disabled');",
    "document.querySelector('#autoSaveStatus').className='autosave-status saved';",
    "document.querySelector('#autoSaveStatus span').textContent='已自动保存 16:42:08';"
  ],
  logs: [
    "document.querySelector('#totalLogs').textContent='5';",
    "document.querySelector('#successRate').textContent='80%';",
    "const logs=[['success','gitlab.example.com','2026-09-14 16:42:18 · 10.3s',''],['success','jira.example.com','2026-09-14 16:42:17 · 10.2s',''],['success','docs.example.com','2026-09-14 16:31:54 · 10.4s',''],['failed','portal.example.com','2026-09-14 16:31:43 · 30.0s','页面加载超时'],['success','wiki.example.com','2026-09-14 16:21:25 · 10.1s','']];",
    "document.querySelector('#allLogs').innerHTML=logs.map(function(log){return '<article class=\\\"log-card\\\"><span class=\\\"result '+log[0]+'\\\">'+(log[0]==='success'?'SUCCESS':'FAILED')+'</span><div><strong>'+log[1]+'</strong><time>'+log[2]+'</time>'+(log[3]?'<small>'+log[3]+'</small>':'')+'</div></article>';}).join('');"
  ]
};

for (const [view, commands] of Object.entries(viewCommands)) {
  const outputPath = "/tmp/sessionkeeper-popup-" + view + "-preview.html";
  const activateView = [
    "document.querySelectorAll('.tab').forEach(function(tab){tab.classList.toggle('active',tab.dataset.view==='" + view + "');});",
    "document.querySelectorAll('.view').forEach(function(panel){panel.classList.toggle('active',panel.dataset.viewPanel==='" + view + "');});"
  ];
  const previewScript = "<script>" + [...baseCommands, ...commands, ...activateView].join("\n") + "</script>";
  const expandedCss = view === "control" ? "" : "body{max-height:none;overflow:auto}.view{height:auto;min-height:474px;overflow:visible}";
  const html = sourceHtml
    .replace('<link rel="stylesheet" href="popup.css">', "<style>" + css + expandedCss + "</style>")
    .replace('<script type="module" src="popup.js"></script>', previewScript);

  fs.writeFileSync(outputPath, html, "utf8");
  console.log(outputPath);
}

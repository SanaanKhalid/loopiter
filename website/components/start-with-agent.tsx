'use client';
import { useState } from 'react';
const platform = 'https://web-loopiter-prod.redmushroom-e2f381a3.centralus.azurecontainerapps.io';
const prompt = `Help me set up Loopiter in this project. Read ${platform}/agent/guide first and follow its workflow. Inspect my existing project to find where Loopiter can improve AI responses, or ask what I want to build if this is a new project. Ask about behavior, protected rules, examples and budgets, implement and test the integration, then give me the connected dashboard link.`;
export function StartWithAgent() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  async function start() {
    setOpen(true);
    try { await navigator.clipboard.writeText(prompt); setCopied(true); }
    catch { setCopied(false); }
  }
  return <div className="agent-start">
    <button className="button" onClick={() => void start()}>{copied ? 'Setup prompt copied' : 'Start with your agent'} <span aria-hidden="true">↗</span></button>
    <p className="agent-start-hint">Paste into Codex or Claude Code. Set up through conversation.</p>
    {open && <div className="agent-start-panel"><label htmlFor="setup-prompt">{copied ? 'Open your project and paste this into your coding agent.' : 'Copy this prompt into your coding agent.'}</label><textarea id="setup-prompt" readOnly rows={6} value={prompt} /><button className="text-link" onClick={() => setOpen(false)}>Close</button></div>}
  </div>;
}

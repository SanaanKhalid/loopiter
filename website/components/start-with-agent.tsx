'use client';
import { useState } from 'react';
const platform = 'https://web-loopiter-prod.redmushroom-e2f381a3.centralus.azurecontainerapps.io';
const prompt = `Help me connect this app to Loopiter so it can improve from feedback. Read ${platform}/agent/guide and inspect my project first. Infer the best fit from the app and my prior decisions. Choose sensible defaults and handle routine technical choices yourself. Explain your recommendation in plain language. Ask only when necessary information is missing, meaningful ambiguity remains, or new authorization is needed, including permitted data and the spending limit. Discuss spending in money. Build and verify the integration, then give me the dashboard link and explain anything still waiting.`;
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

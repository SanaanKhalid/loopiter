"use client";

import { useState } from "react";

export function SdkExample({ pythonCode, nodeCode }: { pythonCode: string; nodeCode: string }) {
  const [language, setLanguage] = useState<"python" | "node">("python");
  const python = language === "python";
  return (
    <div className="hero-console" aria-label="Loopiter SDK example">
      <div className="console-bar">
        <div className="console-title"><span className="status-light" />{python ? "feedback_loop.py" : "feedback-loop.ts"}</div>
        <fieldset className="sdk-language" aria-label="Example language">
          <button type="button" aria-pressed={python} onClick={() => setLanguage("python")}>Python</button>
          <button type="button" aria-pressed={!python} onClick={() => setLanguage("node")}>Node.js</button>
        </fieldset>
      </div>
      <div className="sdk-install"><code>{python ? "python -m pip install 'loopiter==0.3.0a1'" : "npm install loopiter@0.3.0-alpha.1"}</code></div>
      <pre aria-label={`${python ? "Python" : "TypeScript"} example, scroll horizontally to read`}><code>{python ? pythonCode : nodeCode}</code></pre>
      <div className="console-result">
        <span>●</span>
        <div><strong>Review first. Measure before deployment.</strong><small>Connect your evaluator · inspect every proposed change</small></div>
        <b>ALPHA</b>
      </div>
    </div>
  );
}

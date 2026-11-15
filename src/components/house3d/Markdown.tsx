"use client";

import type { ReactNode } from "react";
import { C, SANS, SERIF } from "./model";

/* A small reader for the work agents write. It handles what they actually
   produce: headings, bold, lists, tables and paragraphs. Text is rendered as
   text, never as HTML. */

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i} style={{ fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} style={{ font: "500 0.92em ui-monospace, monospace", background: C.cream, padding: "1px 5px", borderRadius: 5 }}>{part.slice(1, -1)}</code>;
    return part;
  });
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 2;
      const content = heading[2] ?? "";
      out.push(
        level <= 2 ? (
          <h2 key={key++} style={{ font: `300 ${level === 1 ? 34 : 28}px/1.1 ${SERIF}`, letterSpacing: "-0.03em", margin: "26px 0 10px" }}>
            {inline(content)}
          </h2>
        ) : (
          <h3 key={key++} style={{ font: `600 11px/1.4 ${SANS}`, letterSpacing: "0.22em", textTransform: "uppercase", color: C.terracotta, margin: "26px 0 8px" }}>
            {inline(content)}
          </h3>
        ),
      );
      i += 1;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        const row = cells(lines[i] ?? "");
        if (!row.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(row);
        i += 1;
      }
      const [head, ...body] = rows;
      out.push(
        <div key={key++} style={{ overflowX: "auto", margin: "10px 0 14px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", font: `400 14px/1.4 ${SANS}` }}>
            {head && (
              <thead>
                <tr>
                  {head.map((c, k) => (
                    <th key={k} style={{ textAlign: k === 0 ? "left" : "right", padding: "8px 10px", borderBottom: `1.5px solid ${C.ink}`, font: `600 12px/1.3 ${SANS}` }}>
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, k) => (
                    <td key={k} style={{ textAlign: k === 0 ? "left" : "right", padding: "8px 10px", borderBottom: `1px solid ${C.panel}`, fontVariantNumeric: "tabular-nums" }}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i += 1;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key++} style={{ margin: "6px 0 12px", paddingLeft: 22, listStyle: ordered ? "decimal" : "disc", font: `400 15.5px/1.55 ${SANS}` }}>
          {items.map((it, k) => (
            <li key={k} style={{ marginBottom: 5 }}>
              {inline(it)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !/^(#{1,4}\s|\s*([-*]|\d+\.)\s|\|)/.test(lines[i] ?? "")) {
      para.push((lines[i] ?? "").trim());
      i += 1;
    }
    out.push(
      <p key={key++} style={{ font: `400 15.5px/1.6 ${SANS}`, margin: "0 0 12px" }}>
        {inline(para.join(" "))}
      </p>,
    );
  }
  return <div>{out}</div>;
}

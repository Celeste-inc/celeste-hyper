import { useEffect, useRef } from "react";
import { SquareTerminal } from "lucide-react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import type { ModalActions } from "../types";

export function Terminal({ name, pod, container, notify, closeModal }: ModalActions & { name: string; pod: string; container: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({ convertEol: true, cursorBlink: true, fontSize: 12, fontFamily: "var(--font-mono, monospace)" });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    let socket: WebSocket | null = null;
    let disposed = false;

    void http.execToken(name, pod, container).then((res) => {
      if (disposed) return;
      if (res.status >= 400) {
        notify(apiError(res.body, res.status), "bad");
        term.writeln(`\r\n[${apiError(res.body, res.status)}]`);
        return;
      }
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${scheme}//${location.host}/api/services/${encodeURIComponent(name)}/exec?token=${encodeURIComponent(res.body.token)}`;
      const ws = new WebSocket(url);
      socket = ws;
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === "string") return term.write(event.data);
        void (event.data as Blob).text().then((text) => term.write(text));
      };
      term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));
      ws.onclose = () => term.writeln(t("\r\n[session closed]"));
    });

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      socket?.close();
      term.dispose();
    };
  }, [name, pod, container, notify]);

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><SquareTerminal size={22} />{t("Terminal")} — {pod} / {container}</h2>
      <p className="dialog-description">{t("Interactive shell into")} <code>{pod}</code> · {t("container")} <code>{container}</code></p>
      <div ref={hostRef} className="terminal-host" aria-label={t("pod terminal")} />
      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}

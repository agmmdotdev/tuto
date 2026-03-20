"use client";

import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

export function XtermTerminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cursorRef = useRef(0);
  const disposedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    disposedRef.current = false;
    cursorRef.current = 0;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'var(--font-mono), "IBM Plex Mono", Consolas, "Courier New", monospace',
      fontSize: 12,
      letterSpacing: 0.2,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: "#181818",
        black: "#181818",
        blue: "#569cd6",
        brightBlack: "#666666",
        brightBlue: "#9cdcfe",
        brightCyan: "#4ec9b0",
        brightGreen: "#b5cea8",
        brightMagenta: "#d670d6",
        brightRed: "#f48771",
        brightWhite: "#f3f3f3",
        brightYellow: "#ffd866",
        cursor: "#aeafad",
        cyan: "#4ec9b0",
        foreground: "#d4d4d4",
        green: "#6a9955",
        magenta: "#c586c0",
        red: "#f14c4c",
        selectionBackground: "#264f78",
        white: "#d4d4d4",
        yellow: "#dcdcaa",
      },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const postTerminalUpdate = async (body: Record<string, unknown>) => {
      try {
        await fetch(`/api/sessions/${sessionId}/terminal`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch {
        // Ignore transient terminal transport failures.
      }
    };

    const sendResize = () => {
      const currentFitAddon = fitAddonRef.current;
      const currentTerminal = terminalRef.current;

      if (!currentFitAddon || !currentTerminal || disposedRef.current) {
        return;
      }

      currentFitAddon.fit();
      void postTerminalUpdate({
        action: "resize",
        columns: currentTerminal.cols,
        rows: currentTerminal.rows,
      });
    };

    const dataDisposable = terminal.onData((data) => {
      void postTerminalUpdate({
        action: "write",
        input: data,
      });
    });

    const pollTerminal = async () => {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/terminal?cursor=${cursorRef.current}`,
          {
            cache: "no-store",
          },
        );

        if (!response.ok || disposedRef.current) {
          return;
        }

        const payload = (await response.json()) as {
          cursor?: number;
          chunks?: Array<{
            data: string;
          }>;
        };

        if (disposedRef.current) {
          return;
        }

        for (const chunk of payload.chunks ?? []) {
          terminal.write(chunk.data);
        }

        cursorRef.current = payload.cursor ?? cursorRef.current;
      } catch {
        // Ignore transient polling failures.
      }
    };

    void pollTerminal();
    sendResize();

    const interval = window.setInterval(() => {
      void pollTerminal();
    }, 250);
    const resizeObserver = new ResizeObserver(() => {
      sendResize();
    });

    resizeObserver.observe(container);

    return () => {
      disposedRef.current = true;
      window.clearInterval(interval);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  return <div className="h-full w-full px-2 py-2" ref={containerRef} />;
}

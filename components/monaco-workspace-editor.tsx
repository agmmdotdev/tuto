"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { WorkspaceLanguage } from "@/lib/ide/types";

const MonacoEditor = dynamic(
  async () => (await import("@monaco-editor/react")).default,
  {
    ssr: false,
  },
);

let monacoConfigured = false;

function toMonacoLanguage(language: WorkspaceLanguage) {
  switch (language) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "md":
      return "markdown";
    default:
      return language;
  }
}

function configureMonaco(monaco: typeof import("monaco-editor")) {
  if (monacoConfigured) {
    return;
  }

  monacoConfigured = true;

  monaco.editor.defineTheme("tuto-workspace", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1a1715",
      "editorLineNumber.foreground": "#8a7d72",
      "editorLineNumber.activeForeground": "#f4e9dd",
      "editorCursor.foreground": "#ffb48f",
      "editor.selectionBackground": "#5f341f",
      "editor.inactiveSelectionBackground": "#3a261d",
    },
  });

  const typescriptApi = monaco.languages.typescript as unknown as {
    javascriptDefaults: {
      setCompilerOptions(options: object): void;
      setDiagnosticsOptions(options: object): void;
      setEagerModelSync(value: boolean): void;
      addExtraLib(content: string, filePath?: string): void;
    };
    typescriptDefaults: {
      setCompilerOptions(options: object): void;
      setDiagnosticsOptions(options: object): void;
      setEagerModelSync(value: boolean): void;
      addExtraLib(content: string, filePath?: string): void;
    };
  };

  const compilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    jsx: 4,
    module: 99,
    moduleResolution: 2,
    noEmit: true,
    resolveJsonModule: true,
    target: 99,
  };

  typescriptApi.javascriptDefaults.setCompilerOptions(compilerOptions);
  typescriptApi.typescriptDefaults.setCompilerOptions(compilerOptions);
  typescriptApi.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  typescriptApi.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  typescriptApi.javascriptDefaults.setEagerModelSync(true);
  typescriptApi.typescriptDefaults.setEagerModelSync(true);

  const supportLib = `
declare module "*.css";
`;

  typescriptApi.javascriptDefaults.addExtraLib(
    supportLib,
    "file:///workspace/monaco-env.d.ts",
  );
  typescriptApi.typescriptDefaults.addExtraLib(
    supportLib,
    "file:///workspace/monaco-env.d.ts",
  );
}

export function MonacoWorkspaceEditor({
  sessionId,
  runtimeMode,
  packageJsonSeed,
  typeLibrariesUrl,
  extraTypeLibraries,
  filePath,
  language,
  value,
  onChange,
}: {
  sessionId: string;
  runtimeMode: "mock" | "secure-exec" | "host-vite";
  packageJsonSeed: string;
  typeLibrariesUrl?: string;
  extraTypeLibraries?: Array<{ filePath: string; content: string }>;
  filePath: string;
  language: WorkspaceLanguage;
  value: string;
  onChange: (nextValue: string) => void;
}) {
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const remoteTypeDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const extraTypeDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const [monacoReady, setMonacoReady] = useState(false);

  useEffect(() => {
    if (!monacoReady || !monacoRef.current) {
      return;
    }

    if (!typeLibrariesUrl && runtimeMode !== "host-vite") {
      for (const disposable of remoteTypeDisposablesRef.current) {
        disposable.dispose();
      }
      remoteTypeDisposablesRef.current = [];
      return;
    }

    const controller = new AbortController();

    async function loadSessionTypes() {
      const response = await fetch(
        typeLibrariesUrl ?? `/api/sessions/${sessionId}/types`,
        {
          cache: "no-store",
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error("Failed to load session type libraries.");
      }

      const payload = (await response.json()) as {
        libraries?: Array<{ filePath: string; content: string }>;
      };
      const monaco = monacoRef.current;

      if (!monaco) {
        return;
      }

      const typescriptApi = monaco.languages.typescript as unknown as {
        javascriptDefaults: {
          addExtraLib(content: string, filePath?: string): { dispose(): void };
        };
        typescriptDefaults: {
          addExtraLib(content: string, filePath?: string): { dispose(): void };
        };
      };

      for (const disposable of remoteTypeDisposablesRef.current) {
        disposable.dispose();
      }

      remoteTypeDisposablesRef.current = [];

      for (const library of payload.libraries ?? []) {
        const uri = `file:///workspace/${library.filePath}`;

        remoteTypeDisposablesRef.current.push(
          typescriptApi.javascriptDefaults.addExtraLib(library.content, uri),
        );
        remoteTypeDisposablesRef.current.push(
          typescriptApi.typescriptDefaults.addExtraLib(library.content, uri),
        );
      }
    }

    void loadSessionTypes().catch(() => undefined);

    return () => {
      controller.abort();
    };
  }, [
    monacoReady,
    packageJsonSeed,
    runtimeMode,
    sessionId,
    typeLibrariesUrl,
  ]);

  useEffect(() => {
    if (!monacoReady || !monacoRef.current) {
      return;
    }

    const monaco = monacoRef.current;
    const typescriptApi = monaco.languages.typescript as unknown as {
      javascriptDefaults: {
        addExtraLib(content: string, filePath?: string): { dispose(): void };
      };
      typescriptDefaults: {
        addExtraLib(content: string, filePath?: string): { dispose(): void };
      };
    };

    for (const disposable of extraTypeDisposablesRef.current) {
      disposable.dispose();
    }

    extraTypeDisposablesRef.current = [];

    for (const library of extraTypeLibraries ?? []) {
      const uri = `file:///workspace/${library.filePath}`;

      extraTypeDisposablesRef.current.push(
        typescriptApi.javascriptDefaults.addExtraLib(library.content, uri),
      );
      extraTypeDisposablesRef.current.push(
        typescriptApi.typescriptDefaults.addExtraLib(library.content, uri),
      );
    }
  }, [extraTypeLibraries, monacoReady]);

  useEffect(() => {
    return () => {
      for (const disposable of remoteTypeDisposablesRef.current) {
        disposable.dispose();
      }
      for (const disposable of extraTypeDisposablesRef.current) {
        disposable.dispose();
      }
      remoteTypeDisposablesRef.current = [];
      extraTypeDisposablesRef.current = [];
    };
  }, []);

  return (
    <div className="editor-pane">
      <MonacoEditor
        beforeMount={(monaco) => {
          monacoRef.current = monaco;
          configureMonaco(monaco);
          setMonacoReady(true);
        }}
        height="100%"
        language={toMonacoLanguage(language)}
        loading={<div className="editor-loading">Loading editor...</div>}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        options={{
          automaticLayout: true,
          fontLigatures: true,
          fontSize: 13,
          minimap: { enabled: false },
          padding: { top: 16, bottom: 16 },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
        }}
        path={`file:///workspace/${filePath}`}
        saveViewState
        theme="tuto-workspace"
        value={value}
      />
    </div>
  );
}

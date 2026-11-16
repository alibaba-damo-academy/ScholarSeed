import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
} from "../../apps/desktop/src/renderer/src/components/ui";
import type { CardState } from "./contract";

type Register = (id: string, text: string | null, markdown?: string) => void;
const CopyContext = createContext<Register | null>(null);

export async function copyText(text: string): Promise<void> {
  if (!window.plugin.copyText) throw new Error("plugin_copy_unavailable");
  const result = await window.plugin.copyText(text);
  if (
    !result ||
    typeof result !== "object" ||
    !("copied" in result) ||
    result.copied !== true
  )
    throw new Error("plugin_copy_failed");
}

export function withCopyText<
  Props extends { onCopy?: (text: string) => Promise<void> },
>(View: React.ComponentType<Props>): React.ComponentType<Props> {
  return function Copyable(props: Props): React.JSX.Element {
    return <View {...props} onCopy={props.onCopy ?? copyText} />;
  };
}

export function useCopyContent(text: string | null, markdown?: string): void {
  const register = useContext(CopyContext);
  const id = useId();
  useLayoutEffect(() => {
    register?.(id, text, markdown);
  }, [register, id, text, markdown]);
  useLayoutEffect(
    () => () => {
      register?.(id, null);
    },
    [register, id],
  );
}

export function CopyProvider({
  snapshot,
  children,
}: {
  snapshot: CardState;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t: translate } = useTranslation("literature");
  const { t: ui } = useTranslation("ui");
  const contents = useRef(
    new Map<string, { text: string; markdown?: string }>(),
  );
  const pending = useRef(Promise.resolve());
  const generation = useRef(0);
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState(false);
  const register = useCallback<Register>((id, text, markdown) => {
    const previous = contents.current.get(id);
    if (
      previous?.text === (text || undefined) &&
      previous?.markdown === markdown
    )
      return;
    if (text) contents.current.set(id, { text, markdown });
    else contents.current.delete(id);
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    const reconnect = (): void => setVersion((value) => value + 1);
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, []);
  useEffect(() => {
    const requested = ++generation.current;
    const entries = [...contents.current.values()];
    const text = entries.map((entry) => entry.text).join("\n\n");
    const markdown = entries
      .flatMap((entry) => (entry.markdown ? [entry.markdown] : []))
      .join("\n\n");
    if (!text) return;
    let active = true;
    pending.current = pending.current
      .then(async () => {
        if (!active || requested !== generation.current) return;
        await window.plugin.setCopyContent({
          text,
          ...(markdown ? { markdown } : {}),
        });
        if (active) setFailed(false);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [version, snapshot]);
  return (
    <CopyContext.Provider value={register}>
      {children}
      {failed && (
        <Alert
          tone="error"
          description={translate("copyRegistrationFailed")}
          action={
            <Button
              variant="secondary"
              onClick={() => setVersion((value) => value + 1)}
            >
              {ui("retry")}
            </Button>
          }
        />
      )}
    </CopyContext.Provider>
  );
}

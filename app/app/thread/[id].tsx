import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { MotiView } from "moti";
import EventSource from "react-native-sse";
import {
  ReauthRequiredError,
  clearSession,
  getStreamConfig,
  getThread,
  resumeThread,
  sendThreadMessage,
} from "@/lib/api";
import { extractDeltaText, RenderedTurn, toRenderedTurns } from "@/lib/turns";
import { router } from "expo-router";

interface CodexSseEvent {
  method: string;
  params: unknown;
}

function parseSsePayload(raw: string): CodexSseEvent | null {
  try {
    const parsed = JSON.parse(raw) as CodexSseEvent;
    if (!parsed || typeof parsed !== "object" || typeof parsed.method !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const threadId = useMemo(() => (Array.isArray(id) ? id[0] : id), [id]);

  const [turns, setTurns] = useState<RenderedTurn[]>([]);
  const [composerText, setComposerText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState("");

  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let active = true;

    const setup = async () => {
      setError(null);
      setLoading(true);

      try {
        await resumeThread(threadId);
        const thread = await getThread(threadId);
        if (!active) {
          return;
        }

        setTurns(toRenderedTurns(thread.turns));

        const stream = await getStreamConfig(threadId);
        if (!active) {
          return;
        }

        const eventSource = new EventSource(stream.url, {
          headers: {
            Authorization: `Bearer ${stream.token}`,
          },
          pollingInterval: 0,
        });

        eventSource.addEventListener("codex" as never, (event) => {
          const data = (event as { data?: string }).data;
          if (!data) {
            return;
          }

          const payload = parseSsePayload(data);
          if (!payload) {
            return;
          }

          const method = payload.method.toLowerCase();

          if (method.includes("delta")) {
            const delta = extractDeltaText(payload.params);
            if (delta) {
              setStreamingAssistant((existing) => `${existing}${delta}`);
            }
            return;
          }

          if (method.includes("complete") || method.includes("done") || method.includes("turn/end")) {
            setStreamingAssistant((current) => {
              if (!current.trim()) {
                return "";
              }
              setTurns((existing) => [
                ...existing,
                {
                  id: `assistant-${Date.now()}`,
                  role: "assistant",
                  text: current,
                },
              ]);
              return "";
            });
          }
        });

        eventSource.addEventListener("error", () => {
          setError("Stream disconnected. Pull to refresh thread history.");
        });

        eventSourceRef.current = eventSource;
      } catch (setupError) {
        if (setupError instanceof ReauthRequiredError) {
          await clearSession();
          router.replace("/pair");
          return;
        }
        setError(setupError instanceof Error ? setupError.message : "Unable to load thread");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    setup().catch(() => {
      setError("Unable to load thread");
      setLoading(false);
    });

    return () => {
      active = false;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [threadId]);

  const onSend = async () => {
    if (!threadId || !composerText.trim() || sending) {
      return;
    }

    const text = composerText.trim();
    setComposerText("");
    setSending(true);
    setError(null);

    setTurns((existing) => [
      ...existing,
      {
        id: `local-user-${Date.now()}`,
        role: "user",
        text,
      },
    ]);

    try {
      await sendThreadMessage(threadId, { text });
    } catch (sendError) {
      if (sendError instanceof ReauthRequiredError) {
        await clearSession();
        router.replace("/pair");
        return;
      }
      setError(sendError instanceof Error ? sendError.message : "Unable to send message");
    } finally {
      setSending(false);
    }
  };

  const allTurns = streamingAssistant
    ? [
        ...turns,
        {
          id: "live-assistant",
          role: "assistant" as const,
          text: streamingAssistant,
          streaming: true,
        },
      ]
    : turns;

  return (
    <View className="flex-1 bg-[#f6f9ff] px-4 pt-3">
      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#4672a4]">Thread ID</Text>
      <Text className="mb-3 rounded-xl bg-white px-3 py-2 text-xs text-[#1f57a4]">{threadId}</Text>

      {error ? (
        <View className="mb-3 rounded-xl border border-[#f1b7b7] bg-[#fff4f4] p-3">
          <Text className="text-sm text-[#a42f2f]">{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={allTurns}
        keyExtractor={(item) => item.id}
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 14 }}
        renderItem={({ item, index }) => (
          <MotiView
            from={{ opacity: 0, translateY: 6 }}
            animate={{ opacity: 1, translateY: 0 }}
            transition={{ type: "timing", delay: index * 20, duration: 180 }}
            className={`mb-2 rounded-2xl px-3 py-3 ${
              item.role === "user"
                ? "self-end bg-[#2f7de1]"
                : item.streaming
                ? "border border-[#c4ddfb] bg-[#eff6ff]"
                : "bg-white"
            }`}
          >
            <Text className={`text-sm ${item.role === "user" ? "text-white" : "text-[#123154]"}`}>{item.text}</Text>
          </MotiView>
        )}
        ListEmptyComponent={
          !loading ? (
            <View className="rounded-2xl border border-dashed border-[#c4ddfb] bg-white p-4">
              <Text className="text-center text-sm text-[#365f89]">No turns available for this thread yet.</Text>
            </View>
          ) : null
        }
      />

      <View className="mb-4 mt-2 flex-row items-end gap-2">
        <TextInput
          value={composerText}
          onChangeText={setComposerText}
          placeholder="Continue this thread..."
          multiline
          className="max-h-32 flex-1 rounded-2xl border border-[#c4ddfb] bg-white px-4 py-3 text-sm text-[#123154]"
        />
        <Pressable
          disabled={sending || !composerText.trim()}
          onPress={onSend}
          className={`rounded-2xl px-4 py-3 ${sending || !composerText.trim() ? "bg-[#9bbce6]" : "bg-[#2f7de1]"}`}
        >
          <Text className="text-sm font-semibold text-white">{sending ? "..." : "Send"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

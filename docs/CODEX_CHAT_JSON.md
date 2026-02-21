# Codex Chat JSON (Local Codex Sessions)

Use this for Codex's own chat logs, not app/gateway data.

## Fast path (most common): find by screenshot text/snippet

Use any unique phrase from the screenshot/chat text.

```bash
SNIP='paste-unique-text-here'
rg -n --no-messages -S "$SNIP" ~/.codex/sessions
```

If there are many hits, narrow to recent sessions first:

```bash
ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -n 40 | xargs rg -n --no-messages -S "$SNIP"
```

Then open the matched file(s):

```bash
sed -n '1,160p' /path/to/matched-session.jsonl
```

## Find recent Codex sessions

```bash
ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -n 20
```

## Read one chat JSONL file

Replace `<SESSION_JSONL>`:

```bash
sed -n '1,120p' <SESSION_JSONL>
```

## Extract only user/assistant messages

```bash
jq -c 'select(.type=="response_item" and .payload.type=="message" and (.payload.role=="user" or .payload.role=="assistant")) | {ts:.timestamp, role:.payload.role, content:.payload.content}' <SESSION_JSONL>
```

## Find a session by known thread ID

Replace `<THREAD_ID>`:

```bash
rg -n "<THREAD_ID>" ~/.codex/sessions
```

## Optional index file

`~/.codex/session_index.jsonl` is a small index you can scan quickly before opening full session files.

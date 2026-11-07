// Only fixed instructions enter developer context; never interpolate hook input.
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("input limit");
  }
  const event = JSON.parse(input);
  const name = event?.hook_event_name;
  let context;
  if (name === "SessionStart") {
    context =
      "gitbeacon: If this conversation already has coordination enabled, use the gitbeacon-coordination skill for session recovery. This reminder does not enable coordination.";
  } else if (name === "UserPromptSubmit") {
    context =
      "gitbeacon: If coordination is already enabled, use the gitbeacon-coordination skill for the relevant work checkpoint. This reminder does not enable coordination.";
  } else {
    throw new Error("unsupported event");
  }
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: context } }) + "\n",
  );
} catch {
  process.stderr.write("gitbeacon reminder: invalid or unsupported hook input; continuing without context.\n");
}

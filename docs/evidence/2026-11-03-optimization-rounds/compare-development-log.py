import hashlib
import json
import sys
import tarfile
from pathlib import Path

assert len(sys.argv) == 4, "Pass baseline tarball, candidate tarball and saved plugin file map."
root = Path(__file__).resolve().parents[3]
removed = "docs/optimization-rounds.md"


def contents(path):
    with tarfile.open(path) as archive:
        return {
            entry.name.removeprefix("package/"): archive.extractfile(entry).read()
            for entry in archive.getmembers()
            if entry.isfile()
        }


baseline, candidate = (contents(Path(path)) for path in sys.argv[1:3])
assert set(baseline) - set(candidate) == {removed}
assert not set(candidate) - set(baseline)
for name in candidate:
    if name != "package.json":
        assert candidate[name] == baseline[name], name
before = json.loads(baseline["package.json"])
after = json.loads(candidate["package.json"])
after["files"].remove("!" + removed)
assert before == after
plugin_before = json.loads(Path(sys.argv[3]).read_text())
plugin_root = root / ".codex/plugin-build"
plugin_after = {
    str(path.relative_to(plugin_root)): {
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": path.stat().st_size,
    }
    for path in plugin_root.rglob("*")
    if path.is_file()
}
assert set(plugin_before) - set(plugin_after) == {removed}
assert not set(plugin_after) - set(plugin_before)
assert all(value == plugin_before[name] for name, value in plugin_after.items())
print(json.dumps({
    "decision": "Retained: exclude source-only development log from both runtime distributions.",
    "removedPath": removed,
    "removedBytes": len(baseline[removed]),
    "npmCompressedBytes": {name: Path(path).stat().st_size for name, path in zip(["baseline", "candidate"], sys.argv[1:3])},
    "pluginBytes": {"baseline": sum(v["bytes"] for v in plugin_before.values()), "candidate": sum(v["bytes"] for v in plugin_after.values())},
    "assertions": ["Every remaining npm byte is unchanged except the expected files-list entry", "Every remaining plugin byte is unchanged", "Runtime, licenses, SDK types and user documentation are preserved"],
    "limitations": "Isolated round-34 snapshot before further ledger edits. Logical file/compressed tar sizes, not physical I/O. Development log remains in source checkout."
}, indent=2))

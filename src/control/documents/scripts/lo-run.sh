#!/usr/bin/env bash
# Run headless LibreOffice once, with a private hardened profile.
#
#   lo-run.sh convert <input> <format> <outdir> [timeout_seconds]
#
# This is the single place a soffice invocation is constructed, so the hardening
# cannot drift between preview and conversion:
#
#   * `-env:UserInstallation` points at a throwaway profile per run, so two
#     concurrent conversions can never share state;
#   * that profile is pre-seeded with macro security at the highest level and
#     the per-document-type external-link update policy set to "never", so a
#     hostile document cannot run a macro and an external link is not refreshed
#     on load. Macro execution is disabled outright; link updating is prevented
#     by configuration, which is a policy setting rather than a hard network
#     block - the sandbox's own network stays available for normal work;
#   * NO `--` separator: LibreOffice 7.3 rejects it ("Error in option: --").
#     Every path we pass is absolute (and validated to start with `/`), so it can
#     never be mistaken for an option.
set -u

MODE="${1:-}"
INPUT="${2:-}"
FORMAT="${3:-}"
OUTDIR="${4:-}"
# Seconds. render.sh passes the configured per-request budget through, so the
# inner cap can never be shorter than the budget the caller already promised.
LO_TIMEOUT="${5:-180}"
case "$LO_TIMEOUT" in ''|*[!0-9]*) LO_TIMEOUT=180 ;; esac
[ "$LO_TIMEOUT" -ge 5 ] || LO_TIMEOUT=180

[ "$MODE" = "convert" ] || { echo "usage: lo-run.sh convert <input> <format> <outdir> [timeout]" >&2; exit 2; }
[ -n "$INPUT" ] && [ -n "$FORMAT" ] && [ -n "$OUTDIR" ] || { echo "missing argument" >&2; exit 2; }
case "$INPUT" in /*) : ;; *) echo "input must be absolute" >&2; exit 2 ;; esac
case "$OUTDIR" in /*) : ;; *) echo "outdir must be absolute" >&2; exit 2 ;; esac
# A target format is an identifier we hand to LibreOffice; keep it narrow so it
# cannot smuggle an extra option or a filter chain.
case "$FORMAT" in
  *[!a-zA-Z0-9]*) echo "bad format" >&2; exit 2 ;;
esac

command -v soffice >/dev/null 2>&1 || { echo "soffice not found" >&2; exit 3; }

PROFILE=$(mktemp -d /tmp/aio-lo-XXXXXX 2>/dev/null) || exit 4
trap 'rm -rf -- "$PROFILE" 2>/dev/null || true' EXIT

# Pre-seed the profile before LibreOffice starts. LO merges this file into its
# configuration on first load.
mkdir -p -- "$PROFILE/user" 2>/dev/null || exit 4
# Keys below were taken from the registry the pinned image actually ships
# (/usr/lib/libreoffice/share/registry/main.xcd), not from memory:
#   * Common/Security/Scripting/{MacroSecurityLevel,DisableMacrosExecution} exist
#     and are honoured - macros are disabled outright.
#   * The external-link switches are the *document-type* properties
#     <Office.Calc|Office.Writer>/Content/Update/Link. The previously written
#     Common/Save/Document/UpdateDocMode and Common/Load/LinkUpdateMode keys do
#     not exist in this LibreOffice build, so they did nothing.
#     The enumeration is per document type and the two are NOT the same:
#     Calc is 0=always, 1=never, 2=on request (default 2) -> 1 is "never";
#     Writer is 0=always, 1=on request, 2=never (default 1) -> 2 is "never".
#     Values verified against the official Writer.xcs/Calc.xcs schemas.
cat > "$PROFILE/user/registrymodifications.xcu" <<'XCU'
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Filter/PDF/Export"><prop oor:name="UseTaggedPDF" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
XCU

timeout "$LO_TIMEOUT" soffice \
  --headless --norestore --nolockcheck --nodefault --nologo --nofirststartwizard \
  -env:UserInstallation="file://$PROFILE" \
  --convert-to "$FORMAT" --outdir "$OUTDIR" "$INPUT"
status=$?
exit $status

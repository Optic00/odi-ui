#!/usr/bin/env bash
#
# Run the daemon and talk HTTP to it, without a stick.
#
# The binary is big-endian MIPS; qemu-user-static in the toolchain image
# executes it on the build host. That is enough to exercise the whole request
# path -- reading a request, authenticating it, parsing a form body, validating
# a value -- which is the part of this daemon where a mistake is SILENT on real
# hardware. The write path itself is not exercised: /etc/scripts/flash does not
# exist here, so a write is expected to report that it did not stick, and the
# assertions below are about what the daemon accepted and refused, not what it
# stored.
#
# Every case here is a bug this has actually had.
#
#   scripts/smoke.sh          (via make smoke; runs itself inside the container)

set -euo pipefail
cd "$(dirname "$0")/.."

BIN=build/confd
PORT=18080
# Deliberately NOT the built-in default: with both the same, every check below
# passes whether the fallback works, is broken, or is ignored.
AUTH='admin:s3cret'

if [ "${IN_CONTAINER:-0}" != 1 ]; then
	# --cap-add SYSLOG so /api/log can actually be tested. klogctl is refused
	# in a default container (no CAP_SYSLOG, and the Docker VM sets
	# dmesg_restrict=1), and without the capability that route answers "the
	# kernel would not hand over its log buffer" here while working fine on
	# a stick -- a check that always fails teaches nothing. The container
	# reads the host VM's ring buffer; the assertion is only that bytes came
	# back, and nothing is written to it.
	IMAGE=$(scripts/toolchain-image.sh) || exit 1
	docker run --rm --cap-add SYSLOG -v "$PWD":/src -w /src "$IMAGE" \
		env IN_CONTAINER=1 scripts/smoke.sh
	exit $?
fi

[ -x "$BIN" ] || { echo "no $BIN -- run 'make confd' first" >&2; exit 1; }

# The daemon reads absolute paths. We are root in the container, so give it the
# real ones rather than teaching it about a prefix it would only need for tests.
mkdir -p /etc/confd /etc/config
cp schema/keys.tsv schema/meta.tsv schema/consumers.tsv schema/features.tsv schema/settings.tsv /etc/confd/
cp web/*.html web/*.css web/*.js /etc/confd/
printf '%s' "$AUTH" > /etc/config/confd.auth
chmod 600 /etc/config/confd.auth

# A stand-in for /etc/scripts/flash, so the write path runs end to end rather
# than stopping at a missing binary. It answers in the two shapes the daemon
# parses: `flash all <store>` prints the config XML, `flash set K V` echoes
# "K=V" the way the real one echoes its own xmlconfig read-back. That is enough
# to exercise write_key's read-back comparison and to give /api/values
# something real to return.
mkdir -p /etc/scripts
cat > /etc/scripts/flash <<'FLASH'
#!/bin/sh
case "$1" in
all)
	# /etc/config/failstore names a store whose dump fails the way the odi-oss
	# script does without its file: one line on stderr and exit 1.
	# /etc/config/emptystore names one that prints nothing and exits 0.
	if [ "$(cat /etc/config/failstore 2>/dev/null)" = "$2" ]; then
		echo "flash: /var/config/lastgood_$2.xml is not there -- is the config partition mounted?" >&2
		exit 1
	fi
	[ "$(cat /etc/config/emptystore 2>/dev/null)" = "$2" ] && exit 0
	# /etc/config/padcs holds a row count: the cs store then starts with that
	# many table rows, the way a stick that ran a router firmware keeps its WAN
	# table, and the hs store carries GPON_SN, so a cut shows as a missing key.
	if [ -f /etc/config/padcs ]; then
		case "$2" in
		cs) awk -v n="$(cat /etc/config/padcs)" 'BEGIN { for (i = 0; i < n; i++)
			printf "<Dir Name=\"ATM_VC_TBL\"> <!--index=%d-->\n  <Value Name=\"pppUser\" Value=\"\"/>\n</Dir>\n", i }' ;;
		hs) echo '<Value Name="GPON_SN" Value="ODIX00000001"/>' ;;
		esac
	fi
	cat <<'XML'
<Dir Name="MIB_TABLE">
  <Value Name="VLAN_MANU_TAG_VID" Value="110"/>
  <Value Name="VLAN_CFG_TYPE" Value="1"/>
  <Value Name="LAN_IP_ADDR" Value="192.168.1.1"/>
  <Value Name="PON_VENDOR_ID" Value="ODI0"/>
</Dir>
<Dir Name="SW_PORT_TBL"> <!--index=1-->
  <Value Name="PVID" Value="1"/>
</Dir>
<Dir Name="EPON_LLID_TBL">
</Dir>
		<Value Name="NTP_SERVER" Value="192.168.0.2"/>
XML
	;;
get)
	# The stored value of one key, as `flash get` prints it: from the same XML.
	# Prints nothing for a key the store does not hold.
	# A key in /etc/config/getfake ("K=V" lines) wins: a test stores one there.
	grep "^$2=" /etc/config/getfake 2>/dev/null && exit 0
	"$0" all cs | sed -n "s/.*Name=\"$2\" Value=\"\([^\"]*\)\".*/$2=\1/p" | head -n 1
	;;
set)
	echo "$2=$3"
	;;
default)
	# The real script rewrites /var/config/lastgood.xml from the built-in MIB
	# defaults and says this. Only the cs store is ever asked for -- the route
	# hardcodes it, and this refuses anything else so that stays testable.
	[ "$2" = cs ] || { echo "Restore to default configurationg fail."; exit 1; }
	echo "Reset CS to default configuration success."
	echo "Please reboot system."
	;;
esac
FLASH
chmod +x /etc/scripts/flash

# The daemon reads /sys/class/hwmon, which cannot be stubbed here, so its second
# argument moves that directory (src/main.c); a directory that does not exist is
# a stick without the sensor.
HWMON=/tmp/hwmon-stub
rm -rf "$HWMON"
qemu-mips-static "$BIN" "$PORT" "$HWMON" &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT

for _ in $(seq 40); do
	curl -fsS -u "$AUTH" -o /dev/null "http://127.0.0.1:$PORT/api/schema" && break
	sleep 0.25
done

pass=0
fail=0
check() {  # check <name> <expected> <actual>
	if [ "$2" = "$3" ]; then
		pass=$((pass + 1))
		printf '  ok    %s\n' "$1"
	else
		fail=$((fail + 1))
		printf '  FAIL  %s\n        expected %s, got %s\n' "$1" "$2" "$3"
	fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
err() { case "$1" in *"$2"*) echo yes ;; *) echo "no: $1" ;; esac; }

# A stand-in for /bin/omcicli. The route builds its argv from the query string,
# so the stub ECHOES what it was given before printing a dump: that is what
# makes "the entity id reaches the command" a check that can fail, rather than
# an assumption. Real omcicli is not runnable here -- it talks to omci_app.
# A stand-in for /bin/diag. It reads commands on stdin the way the real one
# does, because that batching is the whole reason status is one fork rather
# than seven -- and until now nothing here exercised it at all: /api/status and
# /api/l2 were both untested, and a missing /bin/diag reads as "diag failed",
# which is indistinguishable from a stick with a broken one.
#
# The l2-table reply is the REAL capture in scripts/fixtures/, not something
# shaped to match the parser.
cat > /bin/diag <<'DIAG'
#!/bin/sh
# argv form first: the l2 route uses it because diag never returns when that
# command is fed on stdin. If this stub only handled stdin, the route could go
# back to stdin and the check would still pass.
case "$1" in
l2-table) cat /src/scripts/fixtures/l2-table.txt; exit 0 ;;
esac
while read -r l; do
	printf "RTK.0> %s\n" "$l"
	case "$l" in
	*"transceiver rx-power"*)    printf "  Rx Power          : -18.42 dBm\n" ;;
	*"transceiver tx-power"*)    printf "  Tx Power          : 2.15 dBm\n" ;;
	*"transceiver temperature"*) printf "  Temperature       : 45.50 C\n" ;;
	*"transceiver voltage"*)     printf "  Voltage           : 3.28 V\n" ;;
	*"transceiver bias-current"*) printf "  Bias Current      : 14.05 mA\n" ;;
	*onu-state*)                 printf "  Operation State(O5)\n" ;;
	*alarm-status*)              printf "  LOS Alarm         : clear\n" ;;
	*"counter port all"*)        printf "Port: 0\n  ifInOctets : 1\nPort: 2\n  ifInOctets : 2\n" ;;
	*l2-table*)                  cat /src/scripts/fixtures/l2-table.txt ;;
	*)                           printf "  ok\n" ;;
	esac
done
DIAG
chmod +x /bin/diag

# An nv stub. Without one sw_active is unknown, and the guard that refuses to
# write the RUNNING partition has nothing to compare against -- so the check
# below would pass whether that guard works or is absent.
cat > /bin/nv <<'NV'
#!/bin/sh
echo "$*" >> /tmp/nv.calls
# `nv commit`: odi-oss nv answers every outcome with "nv: commit <slot>: ...";
# /tmp/nv.vendor makes it the stock nv, which prints usage and knows no commit.
if [ "$1" = commit ]; then
	[ -f /tmp/nv.vendor ] && { echo "Usage: nv getenv [parameter_name]"; exit 1; }
	[ -f /tmp/nv.crash ] && { echo "boom"; exit 2; }
	[ -f /tmp/nv.refuse ] && { echo "nv: commit $2: that is not the slot this kernel was booted from (root= in /proc/cmdline), nothing written"; exit 1; }
	echo "nv: commit $2: committed in both copies, read back"
	exit 0
fi
# The running partition: 0, or what /tmp/nv.active holds; /tmp/nv.noactive
# leaves sw_active out of the environment altogether.
act=0
[ -f /tmp/nv.active ] && act=$(cat /tmp/nv.active)
sw=""
[ -f /tmp/nv.noactive ] || sw="sw_active=$act\n"
case "$1 $2" in
"getenv sw_active") echo "sw_active=$act" ;;
"getenv ") printf "${sw}sw_commit=0\nsw_tryactive=2\nsw_version0=a\nsw_version1=b\n" ;;
"getenv")  printf "${sw}sw_commit=0\nsw_tryactive=2\nsw_version0=a\nsw_version1=b\n" ;;
esac
exit 0
NV
chmod +x /bin/nv

# The refresh the commit route runs afterwards. /tmp/slot-state.fail makes it
# exit non-zero.
cat > /etc/scripts/slot-state.sh <<'SLOTSTATE'
#!/bin/sh
echo refreshed >> /tmp/slot-state.calls
[ -f /tmp/slot-state.fail ] && exit 1
exit 0
SLOTSTATE
chmod +x /etc/scripts/slot-state.sh

cat > /bin/omcicli <<'OMCICLI'
#!/bin/sh
echo "ARGV: $*"
[ "$1 $2 $3" = "mib get 84" ] && cat /src/scripts/fixtures/omci/84-VlanTagFilterData.txt
# An older omcid prints provisioned secrets unmasked; a daemon that masks them
# would show ** here. The route must not depend on which one is installed.
case "$3" in 148|157|307|0148|65530|LoIdAuth|loidauth|AuthSecMethod|authsecmethod|LargeString|all) echo "Secret: 0x53454352455431 SECRET1" ;; esac
# `omcicli voip`: the masked view by default, the password only with --secrets.
if [ "$1" = voip ]; then
	if [ "$2" = "--secrets" ]; then
		echo "port 0x201 (voice CTP 0x1)"
		echo "  sip user 0x1: aor 15551235678, display name Example"
		echo "  sip user login 0x3: username voipuser, password SIPPASS9, realm example.net"
	else
		echo "port 0x201 (voice CTP 0x1)"
		echo "  sip user 0x1: aor MASKED-5678, display name MASKED-mple"
		echo "  sip user login 0x3: username MASKED-user, password set (8 bytes), realm example.net"
	fi
	echo "  sip agent 0x1"
	echo "    proxy sip:proxy.example.net"
	echo "  voice vlan 100 priority 5 (IP host 0x1)"
	echo "  line status config done (14)"
fi
exit 0
OMCICLI
chmod +x /bin/omcicli

echo "== auth"
check "no credential is refused"    401 "$(code "http://127.0.0.1:$PORT/api/schema")"
check "wrong credential is refused" 401 "$(code -u admin:wrong "http://127.0.0.1:$PORT/api/schema")"
check "right credential is served"  200 "$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"

# HTTP/1.1, and revalidation of what changes only with the image: an ETag, a
# 304 with no body for a matching If-None-Match, the credential still asked
# for. What the device holds stays no-store.
U="http://127.0.0.1:$PORT"
H=$(curl -s -i -u "$AUTH" "$U/api/schema" | tr -d '\r')
check "http: answers HTTP/1.1" yes "$(err "$H" 'HTTP/1.1 200 OK')"
check "http: and still closes the connection" yes "$(err "$H" 'Connection: close')"
check "cache: schema may be kept if revalidated" yes "$(err "$H" 'Cache-Control: private, no-cache')"
tag=$(printf '%s\n' "$H" | sed -n 's/^ETag: //p')
check "cache: schema has a quoted tag" yes "$(printf '%s' "$tag" | grep -qE '^"[0-9a-f]{8}"$' && echo yes || echo "no: $tag")"
check "cache: the same tag on the next request" "$tag" \
	"$(curl -s -i -u "$AUTH" "$U/api/schema" | tr -d '\r' | sed -n 's/^ETag: //p')"
check "cache: the tag answers 304" 304 "$(code -u "$AUTH" -H "If-None-Match: $tag" "$U/api/schema")"
check "cache: and the 304 has no body" 0 \
	"$(curl -s -u "$AUTH" -H "If-None-Match: $tag" "$U/api/schema" | wc -c | tr -d ' ')"
check "cache: another tag gets the body" 200 "$(code -u "$AUTH" -H 'If-None-Match: "00000000"' "$U/api/schema")"
check "cache: a 304 still needs the credential" 401 "$(code -H "If-None-Match: $tag" "$U/api/schema")"
check "cache: meta has its own tag" no \
	"$([ "$(curl -s -i -u "$AUTH" "$U/api/meta" | tr -d '\r' | sed -n 's/^ETag: //p')" = "$tag" ] && echo yes || echo no)"
atag=$(curl -s -i -u "$AUTH" "$U/app.js" | tr -d '\r' | sed -n 's/^ETag: //p')
check "cache: an asset answers 304 to its tag" 304 "$(code -u "$AUTH" -H "If-None-Match: $atag" "$U/app.js")"
check "cache: values stay no-store" yes "$(err "$(curl -s -i -u "$AUTH" "$U/api/values")" 'Cache-Control: no-store')"
check "cache: status stays no-store" yes "$(err "$(curl -s -i -u "$AUTH" "$U/api/status")" 'Cache-Control: no-store')"
# The start-up bundles: /api/static is every image file the single routes
# answer, under one tag; /api/init is what the device holds, no-store. Each
# member is the single route's answer byte for byte (the same emitter), so a
# text match is the check; the container's python has no json module.
SB=$(curl -s -u "$AUTH" "$U/api/static")
for k in schema meta consumers settings features baseline defaults; do
	check "static: $k is what /api/$k answers" yes "$(err "$SB" "\"$k\":$(curl -s -u "$AUTH" "$U/api/$k")")"
done
check "static: one object, schema first" yes "$(err "${SB%%:*}" '{"schema"')"
stag=$(curl -s -i -u "$AUTH" "$U/api/static" | tr -d '\r' | sed -n 's/^ETag: //p')
check "static: answers 304 to its tag" 304 "$(code -u "$AUTH" -H "If-None-Match: $stag" "$U/api/static")"
check "static: a 304 still needs the credential" 401 "$(code -H "If-None-Match: $stag" "$U/api/static")"
IB=$(curl -s -i -u "$AUTH" "$U/api/init" | tr -d '\r')
check "init: no-store" yes "$(err "$IB" 'Cache-Control: no-store')"
IJ=$(curl -s -u "$AUTH" "$U/api/init")
check "init: values is what /api/values answers" yes "$(err "$IJ" "{\"values\":$(curl -s -u "$AUTH" "$U/api/values"),\"firmware\":{\"running\":")"
# Up to the uptime, which may tick between the two requests.
HL=$(curl -s -u "$AUTH" "$U/api/hostlink")
check "init: hostlink is what /api/hostlink answers" yes "$(err "$IJ" ",\"hostlink\":${HL%%,\"uptime\"*},\"uptime\":")"
check "init: needs the credential" 401 "$(code "$U/api/init")"
check "the credential file is in force" false \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"

# Changing the credential from the UI. This is the way out of the built-in
# default, so it has to work on a stick that has no file at all -- the state
# every factory-reset stick is in.
echo "== setting the credential"
mv /etc/config/confd.auth /etc/config/confd.auth.kept
check "the default is reported while it is in force" true \
	"$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"
check "a password can be set with no file present" yes \
	"$(err "$(curl -s -u admin:admin -X POST -d 'user=op&password=hunter22' "http://127.0.0.1:$PORT/api/password")" '"ok":true')"
check "the file was created 0600" 600 \
	"$(stat -c '%a' /etc/config/confd.auth 2>/dev/null)"
check "the new credential works" 200 \
	"$(code -u op:hunter22 "http://127.0.0.1:$PORT/api/schema")"
check "no temp file is left beside the credential" no \
	"$([ -e /etc/config/confd.auth.new ] && echo yes || echo no)"
check "the default stops working once one is set" 401 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"
check "and the default is no longer reported" false \
	"$(curl -s -u op:hunter22 "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"

# A credential that cannot be expressed in the file format is REFUSED, not
# quietly rewritten into one that can: a mangled credential is one nobody can
# log in with, on a device where finding that out means a site visit.
for bad in 'user=a:b&password=hunter22' 'user=&password=hunter22' \
           'user=op&password=abc' 'user=op&password=' 'user=op' 'password=x'; do
	check "refuses $bad" 400 \
		"$(code -u op:hunter22 -X POST -d "$bad" "http://127.0.0.1:$PORT/api/password")"
done
check "a newline in the password is refused" 400 \
	"$(code -u op:hunter22 -X POST -d 'user=op&password=one%0Atwo' "http://127.0.0.1:$PORT/api/password")"

# Writing admin:admin into the file must NOT clear the warning: the question
# the page answers is "is this stick on the credential everybody knows", and
# a file containing the default is the worst of both.
curl -s -u op:hunter22 -X POST -d 'user=admin&password=admin' "http://127.0.0.1:$PORT/api/password" >/dev/null
check "a file holding the default still reports the default" true \
	"$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"
mv /etc/config/confd.auth.kept /etc/config/confd.auth

# The fallback. A stick flashed with an image that has never had a credential
# file written -- which is every stick after a factory reset, since
# /etc/config IS the partition that gets erased -- must still be reachable.
# It falls back to a WEAKER credential, never to none, so the refusals above
# must all still hold with no file present.
mv /etc/config/confd.auth /etc/config/confd.auth.kept
check "with no file, the default credential works" 200 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"
check "with no file, no credential is still refused" 401 \
	"$(code "http://127.0.0.1:$PORT/api/schema")"
check "with no file, a wrong credential is still refused" 401 \
	"$(code -u admin:wrong "http://127.0.0.1:$PORT/api/schema")"
check "with no file, the file's credential no longer works" 401 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"
check "the page is told the default is in force" true \
	"$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/firmware" | sed -n 's/.*"defaultauth":\([a-z]*\).*/\1/p')"

# An empty file is how anyone clears a password, and treating it as "accept
# nothing" would lock the operator out of the device they were changing it on.
: > /etc/config/confd.auth
check "an empty file falls back rather than locking out" 200 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"

# A file that is there but cannot be read is not an absent one: falling back
# would put admin:admin in force on a stick whose owner set a password. A
# directory in its place makes the read fail (EISDIR) the way an I/O error
# would; every login is refused until it reads again.
rm -f /etc/config/confd.auth && mkdir /etc/config/confd.auth
check "an unreadable credential file does not fall back to the default" 401 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"
check "and it refuses the real credential too, rather than guess" 401 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"
rmdir /etc/config/confd.auth

# And a real credential must still WIN over the default once it exists,
# otherwise the fallback would be a permanent second key.
mv /etc/config/confd.auth.kept /etc/config/confd.auth
check "a real credential overrides the default" 200 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"
check "and the default stops working once it does" 401 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"

echo "== ssh keys"
rm -f /etc/config/dropbear.d/authorized_keys
check "no file lists no keys" '{"path":"/etc/config/dropbear.d/authorized_keys","keys":[]}' \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")"
check "a line that is not a key is refused" 400 \
	"$(code -u "$AUTH" -X POST --data-urlencode 'key=hello world' "http://127.0.0.1:$PORT/api/sshkeys")"
check "an empty key is refused" 400 \
	"$(code -u "$AUTH" -X POST -d 'key=' "http://127.0.0.1:$PORT/api/sshkeys")"
K1='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxJq2sL3o5p8Qh1u7v9wXyZaBcDeFgHiJkLmNoPqRsT laptop'
K2='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQADChEYHyYtNDtCSVBXXmVsc3qBiI+WnaSrsrnAx87V3OPq8fj/Bg0UGyIpMDc+RUxTWmFob3Z9hIuSmaCnrrW8w8rR2N/m7fT7AgkQFx4lLDM6QUhPVl1ka3J5gIeOlZyjqrG4v8bN1Nvi6fD3/gUMExohKC82PURLUllgZ251fIOKkZifpq20u8LJ0Nfe5ezz+gEIDxYdJCsyOUBHTlVcY2pxeH+GjZSboqmwt77FzNPa4ejv9v0ECxIZICcuNTxDSlFYX2ZtdHuCiZCXnqWss7rByM/W3eTr8vkABw4VHCMqMTg/Rk1UW2JpcHd+hYyTmqGor7a9xMvS2eDn7vX8 desk'
check "a key is added" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")" '"ok":true')"
check "and a second one" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "key=$K2" "http://127.0.0.1:$PORT/api/sshkeys")" '"ok":true')"
check "the file has both, one per line, mode 600" "2 600" \
	"$(wc -l < /etc/config/dropbear.d/authorized_keys | tr -d ' ') $(stat -c '%a' /etc/config/dropbear.d/authorized_keys)"
check "the list carries both with their line numbers" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")" '{"i":0,"line":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxJq2sL3o5p8Qh1u7v9wXyZaBcDeFgHiJkLmNoPqRsT laptop"},{"i":1,"line":"ssh-rsa')"
check "deleting the first leaves the second at line 0" yes \
	"$(curl -s -u "$AUTH" -X POST -d 'delete=0' "http://127.0.0.1:$PORT/api/sshkeys" >/dev/null; err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")" '"keys":[{"i":0,"line":"ssh-rsa')"
check "deleting a line that is not there is 404" 404 \
	"$(code -u "$AUTH" -X POST -d 'delete=7' "http://127.0.0.1:$PORT/api/sshkeys")"
check "delete with a non-number is refused, not read as line 0" 400 \
	"$(code -u "$AUTH" -X POST -d 'delete=abc' "http://127.0.0.1:$PORT/api/sshkeys")"
check "delete with trailing junk is refused too" 400 \
	"$(code -u "$AUTH" -X POST -d 'delete=0x' "http://127.0.0.1:$PORT/api/sshkeys")"
check "and the key is still there" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")" '"keys":[{"i":0,"line":"ssh-rsa')"
# Written by rename: a leftover temp file from an interrupted write is replaced,
# never followed, and nothing is left behind afterwards.
echo stale > /tmp/planted
ln -sf /tmp/planted /etc/config/dropbear.d/authorized_keys.new
check "a key is added past a stale temp file that is a link" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")" '"ok":true')"
check "the link target was not written" stale "$(cat /tmp/planted)"
check "no temp file is left beside the keys" no \
	"$([ -e /etc/config/dropbear.d/authorized_keys.new ] || [ -L /etc/config/dropbear.d/authorized_keys.new ] && echo yes || echo no)"
check "the key file holds both lines" 2 "$(wc -l < /etc/config/dropbear.d/authorized_keys | tr -d ' ')"
rm -f /tmp/planted
KF=/etc/config/dropbear.d/authorized_keys
# The file holds K2, then K1. A delete that names the line as it was listed
# removes it only while the file still reads so: a list from before another
# change (a second tab, an edit over ssh) names by number what is now another
# key.
check "a delete naming the text of another line is refused" 409 \
	"$(code -u "$AUTH" -X POST -d 'delete=0' --data-urlencode "line=$K1" "http://127.0.0.1:$PORT/api/sshkeys")"
check "and nothing was removed" 2 "$(wc -l < $KF | tr -d ' ')"
check "a delete naming the line as it reads removes it" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'delete=0' --data-urlencode "line=$K2" "http://127.0.0.1:$PORT/api/sshkeys")" '"ok":true')"
check "and the other key is what is left" "$K1" "$(cat $KF)"
# A file larger than the daemon's buffer, as one written by hand over ssh can
# be. The daemon kept what fit: the list was short, and a delete wrote the file
# back without the rest.
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "${K2% desk} host$i"; done > $KF
big=$(wc -c < $KF | tr -d ' ')
check "a key file larger than the buffer is not listed cut" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")" 'larger than confd can hold')"
check "a delete from it is refused" 500 \
	"$(code -u "$AUTH" -X POST -d 'delete=0' "http://127.0.0.1:$PORT/api/sshkeys")"
check "and so is an add" 500 \
	"$(code -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")"
check "and the file is as it was ($big bytes)" "$big" "$(wc -c < $KF | tr -d ' ')"
# A file that cannot be read is not an empty one: an add replaced it with the
# one new key. A link to itself is a read error a root process still gets.
rm -f $KF
ln -s authorized_keys $KF
check "a key file that cannot be read is not listed as empty" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")" 'could not read authorized_keys')"
check "an add to it is refused" 500 \
	"$(code -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")"
check "and it was not replaced" yes "$([ -L $KF ] && echo yes || echo no)"
rm -f $KF
# The page cannot grow the file past what it reads back: 4094 bytes fit, and
# this file has no newline at its end, so the add writes two more than the key.
pad=$((4094 - 2 - ${#K1}))
printf '#%*s' $((pad - 1)) '' > $KF
check "a key that fills the file to the last byte that fits is added" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")" '"ok":true')"
check "and the file, now 4094 bytes, still lists" "4094 yes" \
	"$(wc -c < $KF | tr -d ' ') $(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/sshkeys")" '{"i":1,"line":"ssh-ed25519')"
printf '#%*s' "$pad" '' > $KF
check "one byte more and the add is refused as full" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")" 'authorized_keys is full')"
rm -f $KF
printf '%s\n' "$K1" > $KF
check "without a credential the keys are not readable" 401 \
	"$(code "http://127.0.0.1:$PORT/api/sshkeys")"
rm -f /etc/config/dropbear.d/authorized_keys

echo "== request framing"
# The bug: headers and body in separate segments made the body arrive empty,
# and handle_write answered {"results":[],"apply":"none"} with no error at all.
split_post=$(python3 - "$PORT" "$AUTH" <<'PY'
import base64, socket, sys, time
port, auth = int(sys.argv[1]), sys.argv[2]
body = b"VLAN_MANU_TAG_VID=100"
cred = base64.b64encode(auth.encode()).decode()
s = socket.create_connection(("127.0.0.1", port), timeout=10)
s.sendall(
    b"POST /api/config HTTP/1.0\r\n"
    b"Authorization: Basic " + cred.encode() + b"\r\n"
    b"Content-Type: application/x-www-form-urlencoded\r\n"
    b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n")
time.sleep(0.4)          # a second segment, exactly as a browser sends it
s.sendall(body)
out = b""
while True:
    d = s.recv(4096)
    if not d:
        break
    out += d
print(out.decode("utf-8", "replace").split("\r\n\r\n", 1)[-1])
PY
)
case "$split_post" in
*'"name":"VLAN_MANU_TAG_VID"'*) r=seen ;;
*) r="not seen: $split_post" ;;
esac
check "body in a second segment is read" seen "$r"

# The other half: a body too large used to be truncated mid-value and written.
big=$(python3 -c 'print("&".join("PON_VENDOR_ID=" + "x"*500 for _ in range(60)))')
check "an oversized body is refused, not trimmed" 413 \
	"$(code -u "$AUTH" -X POST --data "$big" "http://127.0.0.1:$PORT/api/config")"

echo "== sessions"
L="http://127.0.0.1:$PORT"
HTML='Accept: text/html,application/xhtml+xml'
challenged() { case "$1" in *WWW-Authenticate*) echo yes ;; *) echo no ;; esac; }
check "a browser opening the page without a session goes to /login" yes \
	"$(err "$(curl -s -D - -o /dev/null -H "$HTML" "$L/")" 'Location: /login')"
check "  and is not challenged, so no browser password dialog" no \
	"$(challenged "$(curl -s -D - -o /dev/null -H "$HTML" "$L/")")"
check "a fetch with no credential gets a bare 401" no \
	"$(challenged "$(curl -s -D - -o /dev/null "$L/api/schema")")"
check "a wrong Basic header is challenged" yes \
	"$(challenged "$(curl -s -D - -o /dev/null -u admin:wrong "$L/api/schema")")"
t=$(curl -s -o /dev/null -w '%{time_total}' "$L/api/schema")
check "a request with no credential is not delayed" yes "$(awk -v t="$t" 'BEGIN { print (t < 0.8) ? "yes" : "no" }')"
check "the sign-in page needs no credential" 200 "$(code "$L/login")"
check "  nor its script" 200 "$(code "$L/login.js")"
check "  nor the stylesheet" 200 "$(code "$L/style.css")"
check "  and keeps its query" 200 "$(code "$L/login?out=1")"
check "nothing else is served without one" 401 "$(code "$L/app.js")"
tok_of() { printf '%s' "$1" | sed -n 's/^Set-Cookie: odi_session=\([0-9a-f]\{32\}\);.*/\1/p'; }
li() { curl -s -D - -o /tmp/login.body -X POST -H "Origin: $L" --data "$1" "$L/api/login"; }
r=$(li 'user=admin&password=wrong')
check "a wrong password is 401" yes "$(err "$r" '401 Unauthorized')"
check "  and says so" yes "$(err "$(cat /tmp/login.body)" 'wrong username or password')"
check "  and sets no cookie" no "$(case "$r" in *Set-Cookie*) echo yes ;; *) echo no ;; esac)"
check "  and does not challenge" no "$(challenged "$r")"
t=$(curl -s -o /dev/null -w '%{time_total}' -X POST -H "Origin: $L" --data 'user=admin&password=wrong' "$L/api/login")
check "  and costs a second" yes "$(awk -v t="$t" 'BEGIN { print (t >= 0.9) ? "yes" : "no" }')"
check "a wrong username is refused too" 401 \
	"$(code -X POST -H "Origin: $L" --data "user=root&password=${AUTH#*:}" "$L/api/login")"
check "a foreign page cannot sign in" 403 \
	"$(code -X POST -H 'Origin: http://evil.example' --data "user=${AUTH%%:*}&password=${AUTH#*:}" "$L/api/login")"
check "  nor a null Origin" 403 \
	"$(code -X POST -H 'Origin: null' --data "user=${AUTH%%:*}&password=${AUTH#*:}" "$L/api/login")"
r=$(li "user=${AUTH%%:*}&password=${AUTH#*:}")
tok=$(tok_of "$r")
check "the right password gets a 32-hex session cookie" 32 "${#tok}"
check "  HttpOnly and SameSite=Strict" yes "$(err "$r" 'odi_session='"$tok"'; Path=/; HttpOnly; SameSite=Strict')"
C="Cookie: odi_session=$tok"
check "the session opens the API" 200 "$(code -H "$C" "$L/api/schema")"
check "  and the page" 200 "$(code -H "$C" -H "$HTML" "$L/")"
check "  among other cookies" 200 "$(code -H "Cookie: a=b; odi_session=$tok; c=d" "$L/api/schema")"
check "a signed-in browser is sent on from /login" yes \
	"$(err "$(curl -s -D - -o /dev/null -H "$C" "$L/login")" 'Location: /')"
last=${tok: -1}
if [ "$last" = 0 ]; then near=${tok%?}1; else near=${tok%?}0; fi
check "a token one digit off is refused" 401 "$(code -H "Cookie: odi_session=$near" "$L/api/schema")"
check "a token one digit too long is refused" 401 "$(code -H "Cookie: odi_session=${tok}0" "$L/api/schema")"
check "a session write still refuses a foreign Origin" 403 \
	"$(code -H "$C" -X POST -H 'Origin: http://evil.example' -d 'what=omci' "$L/api/apply")"
check "  and a null Origin" 403 "$(code -H "$C" -X POST -H 'Origin: null' -d 'what=omci' "$L/api/apply")"
# A Chromium form POST under Referrer-Policy: no-referrer sends Origin: null.
r=$(curl -s -D - -o /dev/null -H "$C" -X POST -H 'Origin: null' "$L/api/logout")
check "sign out from the page's form (Origin: null) goes to /login?out=1" yes "$(err "$r" 'Location: /login?out=1')"
check "  and clears the cookie" yes "$(err "$r" 'odi_session=; Path=/; Max-Age=0')"
check "  and the session is gone" 401 "$(code -H "$C" "$L/api/schema")"
check "sign out with no session still lands on /login" yes \
	"$(err "$(curl -s -D - -o /dev/null -X POST "$L/api/logout")" 'Location: /login?out=1')"
login_tok() { tok_of "$(li "user=${AUTH%%:*}&password=${AUTH#*:}")"; }
first=$(login_tok)
for i in 1 2 3 4 5 6 7 8; do newest=$(login_tok); done
check "a ninth session drops the least recently used" 401 "$(code -H "Cookie: odi_session=$first" "$L/api/schema")"
check "  and keeps the newest" 200 "$(code -H "Cookie: odi_session=$newest" "$L/api/schema")"
a=$(login_tok)
b=$(login_tok)
check "a password change from a session" 200 \
	"$(code -H "Cookie: odi_session=$a" -X POST -H "Origin: $L" --data 'user=admin&password=n3wpass' "$L/api/password")"
check "  keeps that session" 200 "$(code -H "Cookie: odi_session=$a" "$L/api/schema")"
check "  and ends the others" 401 "$(code -H "Cookie: odi_session=$b" "$L/api/schema")"
check "  and Basic takes the new password" 200 "$(code -u admin:n3wpass "$L/api/schema")"
printf '%s' "$AUTH" > /etc/config/confd.auth

echo "== csrf"
check "cross-origin POST is refused" 403 \
	"$(code -u "$AUTH" -X POST -H 'Origin: http://evil.example' \
		--data 'action=reboot' "http://127.0.0.1:$PORT/api/firmware")"
check "same-origin POST is allowed" 200 \
	"$(code -u "$AUTH" -X POST -H "Origin: http://127.0.0.1:$PORT" \
		--data 'LAN_IP_ADDR=192.168.1.1' "http://127.0.0.1:$PORT/api/config")"
check "no Origin still works (curl, scripts)" 200 \
	"$(code -u "$AUTH" -X POST --data 'LAN_IP_ADDR=192.168.1.1' \
		"http://127.0.0.1:$PORT/api/config")"

echo "== host name and foreign pages"
U="http://127.0.0.1:$PORT"
hcode() { curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -H "Host: $1" "$U/api/schema"; }
check "an IPv4 Host is answered" 200 "$(hcode 192.168.1.1)"
check "an IPv4 Host with a port is answered" 200 "$(hcode 192.168.1.1:8080)"
check "an IPv6 literal Host is answered" 200 "$(hcode '[fe80::1]')"
check "a single-label Host is answered" 200 "$(hcode odi)"
check "a .lan Host is answered" 200 "$(hcode stick.lan)"
check "a public name is refused (DNS rebinding)" 403 "$(hcode rebind.example.com)"
check "a public name with a port is refused" 403 "$(hcode rebind.example.com:80)"
check "a look-alike IP-prefixed name is refused" 403 "$(hcode 192.168.1.1.example.com)"
check "a fully qualified single label is refused" 403 "$(hcode stick.)"
check "a rebound name gets no credential prompt" 403 \
	"$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: rebind.example.com' "$U/api/schema")"
printf 'stick.example.org\n' > /etc/config/confd.hosts
check "a name listed in confd.hosts is answered" 200 "$(hcode Stick.Example.org)"
check "an unlisted name is still refused" 403 "$(hcode other.example.org)"
rm -f /etc/config/confd.hosts
check "a fetch from another site is refused" 403 \
	"$(code -u "$AUTH" -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: no-cors' \
		-H 'Sec-Fetch-Dest: image' "$U/api/diag")"
check "a fetch from a sibling port is refused" 403 \
	"$(code -u "$AUTH" -H 'Sec-Fetch-Site: same-site' -H 'Sec-Fetch-Mode: cors' "$U/api/values")"
check "a followed link (top-level navigation) is allowed" 200 \
	"$(code -u "$AUTH" -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' \
		-H 'Sec-Fetch-Dest: document' "$U/")"
check "a followed link to an API route is refused" 403 \
	"$(code -u "$AUTH" -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' \
		-H 'Sec-Fetch-Dest: document' "$U/api/diag")"
# The address redirect (web/netaddr.js): the page on the old address looks for
# the new one with a cross-site no-cors fetch and no credential, then navigates
# there. The probe must get an HTTP answer that says nothing, at once (not the
# one-second delay of a failed sign-in, which would stall the single thread
# every two seconds); the navigation must land on the ordinary sign-in.
probe=$(curl -s -o /tmp/probe.body -w '%{http_code} %{time_total}' -H 'Sec-Fetch-Site: cross-site' \
	-H 'Sec-Fetch-Mode: no-cors' -H 'Sec-Fetch-Dest: empty' "$U/?probe=1700000000000")
check "the redirect probe, with no credential, gets a 403" 403 "${probe%% *}"
check "and it says nothing about the stick" "cross-site request refused" "$(tr -d '\n' < /tmp/probe.body)"
check "and it is not delayed like a failed sign-in" yes \
	"$(awk -v t="${probe#* }" 'BEGIN { print (t < 0.8) ? "yes" : "no" }')"
nav=$(curl -s -D - -o /dev/null -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' \
	-H 'Sec-Fetch-Dest: document' -H 'Accept: text/html' "$U/")
check "the redirect navigation, with no credential, lands on the sign-in page" yes \
	"$(err "$nav" 'Location: /login')"
check "the page after the redirect is the same sign-in: 303, not a token path" 303 \
	"$(code -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' \
		-H 'Accept: text/html' "$U/?t=abcdef")"
check "a followed link to /api/netaddr is refused" 403 \
	"$(code -u "$AUTH" -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' \
		-H 'Sec-Fetch-Dest: document' "$U/api/netaddr")"
check "the redirect probe never reaches the page or the API" 403 \
	"$(code -u "$AUTH" -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: no-cors' -H 'Sec-Fetch-Dest: empty' "$U/api/netaddr")"
long=$(python3 -c 'print("a"*130)')
check "a Host filling the buffer is refused, not judged by its prefix" 403 "$(hcode "$long.example.com")"
check "a long label whose cut prefix has no dot is refused" 403 "$(hcode "$long")"
check "a prefix cut at .lan is refused" 403 "$(hcode "$(python3 -c 'print("a"*123)').lan.evil.example")"
check "a same-origin fetch is allowed" 200 \
	"$(code -u "$AUTH" -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors' "$U/api/schema")"
hdrs=$(curl -s -D - -o /dev/null -u "$AUTH" "$U/api/schema")
check "responses forbid framing" yes "$(err "$hdrs" 'X-Frame-Options: DENY')"
check "responses forbid sniffing" yes "$(err "$hdrs" 'X-Content-Type-Options: nosniff')"
check "responses carry frame-ancestors none" yes "$(err "$hdrs" "frame-ancestors 'none'")"
hdrs=$(curl -s -D - -o /dev/null "$U/api/schema")
check "a 401 carries the headers too" yes "$(err "$hdrs" 'X-Frame-Options: DENY')"

echo "== validation"
post() { curl -s -u "$AUTH" -X POST --data "$1" "http://127.0.0.1:$PORT/api/config"; }

check "a refused SerDes key is refused" yes \
	"$(err "$(post 'LAN_SDS_MODE=4')" 'refused')"
check "an out-of-range VLAN is refused" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=99999')" 'outside the range')"
check "an in-range VLAN passes validation" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=100')" '"name":"VLAN_MANU_TAG_VID"')"
# VLAN_CFG_TYPE, not PON_MODE: PON_MODE is an identity key and is refused one
# rung earlier, which tests the confirmation gate rather than the option list.
check "a value outside an option list is refused" yes \
	"$(err "$(post 'VLAN_CFG_TYPE=9')" 'not one of the values')"
check "a value inside the option list is written" yes \
	"$(err "$(post 'VLAN_CFG_TYPE=1')" '"ok":true,"value":"1"')"
check "a bad octet is refused" yes \
	"$(err "$(post 'LAN_IP_ADDR=1.2.3.999')" 'not valid for its type')"
check "a good address is written" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"ok":true,"value":"192.168.1.1"')"

echo "== apply classification"
# consumers.tsv is authoritative where it has a row. The daemon used to ignore
# the file entirely and call everything that was not restart:omci a reboot.
check "a restart:omci key says so" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=110')" '"apply":"restart:omci"')"
# settings.tsv, this image own table, decides what a write needs: the actions
# the page runs (network) or offers (omci, reboot), and whether a key is read
# by nothing here at all.
check "an omcid key needs the omci action" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=110')" '"needs":["omci"]')"
check "a management address needs the network action" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"needs":["network"]')"
check "and is no longer reported as untraced" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"untraced":false')"
check "a key only the stock firmware reads is reported as such" yes \
	"$(err "$(post 'DNS1=1.1.1.1')" '"needs":[],"stock":true')"
check "a batch reports every action it needs" yes \
	"$(err "$(post 'LAN_IP_ADDR2=192.168.100.1&VLAN_MANU_TAG_PRI=0')" '"needs":["network","omci"]')"
check "SYSLOG_SERVER needs the syslog action" yes \
	"$(err "$(post 'SYSLOG_SERVER=10.0.0.5:514')" '"needs":["syslog"]')"
check "NTP_SERVER needs the ntp action" yes \
	"$(err "$(post 'NTP_SERVER=pool.ntp.org')" '"needs":["ntp"]')"
check "IGMP_SNOOPING needs the igmp action" yes \
	"$(err "$(post 'IGMP_SNOOPING=1')" '"needs":["igmp"]')"
check "SFP_HOST_DDM needs the sfp action" yes \
	"$(err "$(post 'SFP_HOST_DDM=0')" '"needs":["sfp"]')"
check "SFP_HOST_DDM outside 0 and 1 is refused" yes \
	"$(err "$(post 'SFP_HOST_DDM=2')" 'not one of the values')"
check "IGMP_PON_DROP needs the igmp action" yes \
	"$(err "$(post 'IGMP_PON_DROP=1')" '"needs":["igmp"]')"
check "IGMP_PON_DROP outside 0 and 1 is refused" yes \
	"$(err "$(post 'IGMP_PON_DROP=2')" 'not one of the values')"
check "MLD_SNOOPING needs the igmp action" yes \
	"$(err "$(post 'MLD_SNOOPING=1')" '"needs":["igmp"]')"
check "GPON_KEEP_DISABLE needs a reboot only" yes \
	"$(err "$(post 'GPON_KEEP_DISABLE=1')" '"needs":["reboot"]')"
check "OMCI_POTS_PORTS=2 interrupts" yes \
	"$(err "$(post 'OMCI_POTS_PORTS=2')" '"needs":["omci"],"stock":false,"interrupts":true')"
check "OMCI_POTS_PORTS=3 is refused" yes \
	"$(err "$(post 'OMCI_POTS_PORTS=3')" 'not one of the values')"
check "OMCI_POTS_SLOT_ID 9 is written and interrupts" yes \
	"$(err "$(post 'OMCI_POTS_SLOT_ID=9')" '"needs":["omci"],"stock":false,"interrupts":true')"
check "OMCI_POTS_SLOT_ID 1 is outside the range and refused" yes \
	"$(err "$(post 'OMCI_POTS_SLOT_ID=1')" 'outside the range')"
check "OMCI_UNI_LOCK=0 is written and needs nothing" yes \
	"$(err "$(post 'OMCI_UNI_LOCK=0')" '"needs":[],"stock":false,"interrupts":false')"
check "OMCI_TCONT_ALLOC_UNSET=unassigned is written and needs nothing" yes \
	"$(err "$(post 'OMCI_TCONT_ALLOC_UNSET=unassigned')" '"needs":[],"stock":false,"interrupts":false')"
check "both together need both" yes \
	"$(err "$(post 'SYSLOG_SERVER=logs.lan&NTP_SERVER=192.168.1.10:123')" '"needs":["syslog","ntp"]')"
check "an empty SYSLOG_SERVER clears it (hostport keys only)" yes \
	"$(err "$(post 'SYSLOG_SERVER=')" '"ok":true')"
check "an empty NTP_SERVER clears it" yes \
	"$(err "$(post 'NTP_SERVER=')" '"ok":true')"
check "an empty stock key is still refused" yes \
	"$(err "$(post 'LAN_IP_ADDR=')" 'cannot be cleared')"
for bad in 'a b' 'a"b' "a'b" 'host:0' 'host:70000' 'host:' ':514' '-host' 'host.'; do
	check "a bad host is refused: $bad" yes \
		"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "SYSLOG_SERVER=$bad" "http://127.0.0.1:$PORT/api/config")" 'not valid for its type')"
done
# omcid reloads on SIGHUP: a VLAN key is class live and rebuilt in place, an
# identity key re-registers the ONU. Both are the omci action; `interrupts`
# says which, so the page applies the first at once and asks before the second.
check "a VLAN key needs omci, and does not interrupt" yes \
	"$(err "$(post 'VLAN_MANU_TAG_VID=120')" '"needs":["omci"],"stock":false,"interrupts":false')"
check "VLAN_EAPOL_UNTAGGED is written and applied live by omci" yes \
	"$(err "$(post 'VLAN_EAPOL_UNTAGGED=1')" '"needs":["omci"],"stock":false,"interrupts":false')"
check "VLAN_EAPOL_UNTAGGED outside 0 and 1 is refused" yes \
	"$(err "$(post 'VLAN_EAPOL_UNTAGGED=2')" 'not one of the values')"
check "transparent mode is a listed value and does not interrupt" yes \
	"$(err "$(post 'VLAN_MANU_MODE=0')" '"ok":true,"value":"0"')"
check "an identity key needs omci and interrupts" yes \
	"$(err "$(post 'OMCC_VER=128')" '"needs":["omci"],"stock":false,"interrupts":true')"
check "a batch of VLAN and identity keys interrupts" yes \
	"$(err "$(post 'VLAN_MANU_TAG_PRI=0&OMCC_VER=128')" '"interrupts":true')"
check "ONU_HW_VERSION is written and interrupts" yes \
	"$(err "$(post 'ONU_HW_VERSION=HW-2.1')" '"ok":true,"value":"HW-2.1"')"
check "ONU_HW_VERSION needs omci" yes \
	"$(err "$(post 'ONU_HW_VERSION=HW-2.1')" '"needs":["omci"],"stock":false,"interrupts":true')"
check "an empty ONU_HW_VERSION clears it" yes \
	"$(err "$(post 'ONU_HW_VERSION=')" '"ok":true')"
check "an ONU_HW_VERSION of 14 characters passes" yes \
	"$(err "$(post 'ONU_HW_VERSION=12345678901234')" '"ok":true')"
for bad in '123456789012345' 'a"b' 'a&b' 'a<b'; do
	check "a bad ONU_HW_VERSION is refused: $bad" yes \
		"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "ONU_HW_VERSION=$bad" "http://127.0.0.1:$PORT/api/config")" 'not valid for its type')"
done
check "a non-ASCII ONU_HW_VERSION is refused" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "ONU_HW_VERSION=caf$(printf '\303\251')" "http://127.0.0.1:$PORT/api/config")" 'not valid for its type')"
# What the code that reads a key will accept is what the daemon accepts: an
# address or mask the kernel refuses, a serial number the gponsn verb refuses,
# a PLOAM password of the wrong length, a string wider than its OLT field.
# A refused value is never stored, so none of these reaches flash.
pt() {  # pt NAME VALUE: post one value, URL-encoded
	curl -s -u "$AUTH" -X POST --data-urlencode "$1=$2" "http://127.0.0.1:$PORT/api/config"
}
pti() {  # pti NAME VALUE: the same, for an identity key, with the confirmation
	curl -s -u "$AUTH" -X POST --data-urlencode "$1=$2" --data '_confirm=identity' "http://127.0.0.1:$PORT/api/config"
}
for bad in 0.0.0.0 127.0.0.1 224.0.0.1 255.255.255.255 192.168.010.1 192.168.1 1.2.3.4.5; do
	check "an unusable LAN_IP_ADDR is refused: $bad" yes \
		"$(err "$(pt LAN_IP_ADDR "$bad")" 'not valid for its type')"
done
for bad in 255.0.255.0 0.0.0.0 255.255.255.255 255.255.255.254 254.0.0.0 255.255.255.1; do
	check "an unusable LAN_SUBNET is refused: $bad" yes \
		"$(err "$(pt LAN_SUBNET "$bad")" 'not valid for its type')"
done
check "a /30 netmask passes" yes \
	"$(err "$(pt LAN_SUBNET 255.255.255.252)" '"ok":true,"value":"255.255.255.252"')"
check "a /8 netmask passes" yes \
	"$(err "$(pt LAN_SUBNET 255.0.0.0)" '"ok":true,"value":"255.0.0.0"')"
check "a usable LAN_IP_ADDR passes" yes \
	"$(err "$(pt LAN_IP_ADDR 10.20.30.1)" '"ok":true,"value":"10.20.30.1"')"
# The network and broadcast address of the mask are no host's, and network.sh
# refuses them at boot: the daemon judges the address against the netmask
# of the same request, else the stored one (the store here holds none, so /24,
# as network.sh assumes), and the netmask against the address.
for bad in 192.168.1.0 192.168.1.255 10.0.0.0; do
	check "the network or broadcast address of the /24 is refused: $bad" yes \
		"$(err "$(pt LAN_IP_ADDR "$bad")" 'network or broadcast address')"
done
check "the broadcast address of a /23 is refused against the netmask in the same request" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'LAN_IP_ADDR=192.168.1.255&LAN_SUBNET=255.255.254.0' "http://127.0.0.1:$PORT/api/config")" 'network or broadcast address')"
check "the same address passes a /16 in the same request" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'LAN_IP_ADDR=192.168.1.255&LAN_SUBNET=255.255.0.0' "http://127.0.0.1:$PORT/api/config")" '"name":"LAN_IP_ADDR","ok":true')"
check "a netmask that makes the address in the same request its broadcast is refused" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'LAN_IP_ADDR=192.168.1.3&LAN_SUBNET=255.255.255.252' "http://127.0.0.1:$PORT/api/config")" 'netmask that makes')"
printf 'LAN_SUBNET=255.255.254.0\nLAN_IP_ADDR=192.168.0.0\n' > /etc/config/getfake
check "an address alone is judged against the STORED netmask (/23 here)" yes \
	"$(err "$(pt LAN_IP_ADDR 192.168.1.255)" 'network or broadcast address')"
check "a netmask alone is judged against the STORED address (a /23 network address here)" yes \
	"$(err "$(pt LAN_SUBNET 255.255.254.0)" 'netmask that makes')"
check "and passes against a stored address it leaves a host (192.168.0.0 on a /8)" yes \
	"$(err "$(pt LAN_SUBNET 255.0.0.0)" '"ok":true,"value":"255.0.0.0"')"
rm -f /etc/config/getfake
check "the second address is judged the same way" yes \
	"$(err "$(pt LAN_IP_ADDR2 192.168.100.255)" 'network or broadcast address')"
for bad in ODI12345678 ODI0123456789 ODI01234567G 'OD 012345678'; do
	check "a bad GPON_SN is refused: $bad" yes \
		"$(err "$(pti GPON_SN "$bad")" 'not valid for its type')"
done
check "a GPON_SN of four characters and eight hex digits passes" yes \
	"$(err "$(pti GPON_SN ODI0123456aB)" '"ok":true,"value":"ODI0123456aB"')"
for bad in 3132333435363738393 313233343536373839303132 12345678 zz323334353637383930; do
	check "a bad GPON_PLOAM_PASSWD is refused: $bad" yes \
		"$(err "$(pti GPON_PLOAM_PASSWD "$bad")" 'not valid for its type')"
done
check "a GPON_PLOAM_PASSWD of 20 hex digits passes" yes \
	"$(err "$(pti GPON_PLOAM_PASSWD 31323334353637383930)" '"ok":true')"
check "a 14-character OMCI_SW_VER1 passes" yes \
	"$(err "$(pt OMCI_SW_VER1 V1.1.6-2402021)" '"ok":true')"
check "a 15-character OMCI_SW_VER1 is refused" yes \
	"$(err "$(pt OMCI_SW_VER1 V1.1.6-24020212)" 'not valid for its type')"
check "a 21-character GPON_ONU_MODEL is refused" yes \
	"$(err "$(pti GPON_ONU_MODEL 123456789012345678901)" 'not valid for its type')"
check "a 25-character LOID is refused" yes \
	"$(err "$(pt LOID 1234567890123456789012345)" 'not valid for its type')"
check "a 24-character LOID passes" yes \
	"$(err "$(pt LOID 123456789012345678901234)" '"ok":true')"
check "a 13-character LOID_PASSWD is refused" yes \
	"$(err "$(pt LOID_PASSWD 1234567890123)" 'not valid for its type')"
check "a LOID with a quote is refused" yes \
	"$(err "$(pt LOID 'a"b')" 'not valid for its type')"
for bad in 010203040506 000000000000 0102030405 01020304050607; do
	check "a bad ELAN_MAC_ADDR is refused: $bad" yes \
		"$(err "$(pti ELAN_MAC_ADDR "$bad")" 'not valid for its type')"
done
check "HW_SERIAL_NO is not held to the unicast rule" yes \
	"$(err "$(pt HW_SERIAL_NO 010203040506)" '"name":"HW_SERIAL_NO","ok":true')"
check "a unicast ELAN_MAC_ADDR passes" yes \
	"$(err "$(pti ELAN_MAC_ADDR 023a21282716)" '"ok":true')"
check "OLT_SW_DOWNLOAD reject is written and needs nothing" yes \
	"$(err "$(post 'OLT_SW_DOWNLOAD=reject')" '"needs":[],"stock":false,"interrupts":false')"
check "OLT_SW_DOWNLOAD accept is written" yes \
	"$(err "$(post 'OLT_SW_DOWNLOAD=accept')" '"ok":true,"value":"accept"')"
check "OLT_SW_DOWNLOAD outside accept and reject is refused" yes \
	"$(err "$(post 'OLT_SW_DOWNLOAD=maybe')" 'not one of the values')"
check "OMCI_ACCEPT_REBOOT is written and needs nothing" yes \
	"$(err "$(post 'OMCI_ACCEPT_REBOOT=1')" '"needs":[],"stock":false,"interrupts":false')"
check "OMCI_ACCEPT_REBOOT=2 (acknowledge only) is written and needs nothing" yes \
	"$(err "$(post 'OMCI_ACCEPT_REBOOT=2')" '"needs":[],"stock":false,"interrupts":false')"
check "OMCI_ACCEPT_REBOOT outside 0, 1 and 2 is refused" yes \
	"$(err "$(post 'OMCI_ACCEPT_REBOOT=3')" 'not one of the values')"
check "OMCI_UNKNOWN_ME_OK is written and interrupts" yes \
	"$(err "$(post 'OMCI_UNKNOWN_ME_OK=1')" '"needs":["omci"],"stock":false,"interrupts":true')"
check "OMCI_UNKNOWN_ME_OK outside 0 and 1 is refused" yes \
	"$(err "$(post 'OMCI_UNKNOWN_ME_OK=2')" 'not one of the values')"
check "OMCI_VEIP=0 (no VEIP) is written and interrupts" yes \
	"$(err "$(post 'OMCI_VEIP=0')" '"needs":["omci"],"stock":false,"interrupts":true')"
check "OMCI_VEIP outside 0 and 1 is refused" yes \
	"$(err "$(post 'OMCI_VEIP=2')" 'not one of the values')"
check "OMCI_PRIVATE_ME=0 is written and interrupts" yes \
	"$(err "$(post 'OMCI_PRIVATE_ME=0')" '"needs":["omci"],"stock":false,"interrupts":true')"
check "OMCI_PRIVATE_ME outside 0 and 1 is refused" yes \
	"$(err "$(post 'OMCI_PRIVATE_ME=2')" 'not one of the values')"
check "OMCI_VEIP_SLOT_ID 14 is written and interrupts" yes \
	"$(err "$(post 'OMCI_VEIP_SLOT_ID=14')" '"needs":["omci"],"stock":false,"interrupts":true')"
for bad in 1 255 300; do
	check "OMCI_VEIP_SLOT_ID $bad is outside the slots omcid uses and is refused" yes \
		"$(err "$(post "OMCI_VEIP_SLOT_ID=$bad")" 'outside the range')"
done
check "OMCI_FIXED_ME with one entry is written and interrupts" yes \
	"$(err "$(post 'OMCI_FIXED_ME=200:0x0011aa')" '"needs":["omci"],"stock":false,"interrupts":true')"
check "OMCI_FIXED_ME with two entries passes" yes \
	"$(err "$(post 'OMCI_FIXED_ME=200:0x0011aa,201:01020304')" '"ok":true')"
check "OMCI_FIXED_ME with 25 bytes and space separators passes" yes \
	"$(err "$(post 'OMCI_FIXED_ME=200:0102030405060708090a0b0c0d0e0f101112131415161718ff%20201:AA')" '"ok":true')"
check "OMCI_FIXED_ME in the entry form, hex and decimal instances, passes" yes \
	"$(err "$(post 'OMCI_FIXED_ME=200:0x8001:1:0x0011aa,200:32769:2:ff%20201:0xFFFF:16:AA')" '"ok":true')"
check "OMCI_FIXED_ME with both forms on different classes passes" yes \
	"$(err "$(post 'OMCI_FIXED_ME=200:0x8001:1:aa,201:bb')" '"ok":true')"
for bad in 0:aa 65536:aa 200aa 200:abc 200:zz 200:0x 200:aa,200:bb \
	200:0102030405060708090a0b0c0d0e0f101112131415161718191a \
	1:aa,2:aa,3:aa,4:aa,5:aa,6:aa,7:aa,8:aa,9:aa,10:aa,11:aa,12:aa,13:aa,14:aa,15:aa,16:aa,17:aa \
	200:0x8001:0:aa 200:0x8001:17:aa 200:0x10000:1:aa 200:65536:1:aa 200:0x:1:aa \
	200:1:aa 200::1:aa 200:1::aa 200:1:2:3:aa 0xc8:1:1:aa 200:1:1:a 200:1:1:0x \
	200:1:1:aa,200:0x1:1:bb 200:aa,200:1:1:bb 200:1:1:bb,200:aa 200:1:001:aa; do
	check "a bad OMCI_FIXED_ME is refused: $bad" yes \
		"$(err "$(post "OMCI_FIXED_ME=$bad")" 'not valid for its type')"
done
check "sixteen OMCI_FIXED_ME entries pass" yes \
	"$(err "$(post 'OMCI_FIXED_ME=1:aa,2:aa,3:aa,4:aa,5:aa,6:aa,7:aa,8:aa,9:aa,10:aa,11:aa,12:aa,13:aa,14:aa,15:aa,16:aa')" '"ok":true')"
check "an empty OMCI_FIXED_ME clears it" yes \
	"$(err "$(post 'OMCI_FIXED_ME=')" '"ok":true')"
check "RTK_DEVINFO_SPECVER (FwdOp override) is written and applied live by omci" yes \
	"$(err "$(post 'RTK_DEVINFO_SPECVER=0x1102:0x00,0x110b')" '"needs":["omci"],"stock":false,"interrupts":false')"
check "RTK_DEVINFO_SPECVER in decimal with a space separator passes" yes \
	"$(err "$(post 'RTK_DEVINFO_SPECVER=4354:0%204363:16')" '"ok":true')"
for bad in 0x1102:0x100 0x10000 0x1102: zz 0x1102:0x00:1 0x1102,4354 \
	0,1,2,3,4,5,6,7,8,9,10,11,12; do
	check "a bad RTK_DEVINFO_SPECVER is refused: $bad" yes \
		"$(err "$(post "RTK_DEVINFO_SPECVER=$bad")" 'not valid for its type')"
done
check "an empty RTK_DEVINFO_SPECVER clears the override" yes \
	"$(err "$(post 'RTK_DEVINFO_SPECVER=')" '"ok":true')"
check "settings.tsv is served" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/settings")" '"name":"LAN_ENABLE_IP2","apply":"live","action":"network"')"
check "the VLAN keys are live and applied by omci" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/settings")" '"name":"VLAN_MANU_TAG_VID","apply":"live","action":"omci"')"
# Without the table, the old classification stands.
mv /etc/confd/settings.tsv /tmp/settings.tsv.kept
check "without settings.tsv an untraced key is reported as untraced" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"untraced":true')"
check "and no actions are listed" yes \
	"$(err "$(post 'LAN_IP_ADDR=192.168.1.1')" '"needs":[]')"
check "and /api/settings answers an empty list" '[]' \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/settings")"
mv /tmp/settings.tsv.kept /etc/confd/settings.tsv
check "an identity key needs confirmation" yes \
	"$(err "$(post 'GPON_SN=ODI012345678')" '_confirm=identity')"
check "an unknown key is refused" yes \
	"$(err "$(post 'NOT_A_REAL_KEY=1')" 'not in the schema')"

echo "== web assets"
# Every module the page imports must actually be served, and nothing outside
# the table may be. A 404 on one module is a blank page in a browser and
# nothing at all in a log.
for f in web/*.js web/*.css web/*.html; do
	b=$(basename "$f")
	u="/$b"; [ "$b" = index.html ] && u="/"; [ "$b" = login.html ] && u="/login"
	check "serves $b" 200 "$(code -u "$AUTH" "http://127.0.0.1:$PORT$u")"
done
check "an unlisted file is refused" 404 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/keys.tsv")"
# The table is literals, so there is no path to traverse -- assert it anyway,
# because /etc/config/confd/ next door holds the credential.
for p in "/../confd.auth" "/..%2fconfd.auth" "//etc/config/confd.auth"; do
	check "refuses $p" 404 "$(code -u "$AUTH" "http://127.0.0.1:$PORT$p")"
done

echo "== routes"
check "sign out with a Basic header answers 401, not 405" 401 \
	"$(code -u "$AUTH" -X POST "http://127.0.0.1:$PORT/api/logout")"
check "any other write with Origin: null is still refused" 403 \
	"$(code -u "$AUTH" -X POST -H 'Origin: null' -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")"
check "values are parsed and served" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" '"LAN_IP_ADDR":"192.168.1.1"')"
check "an indexed table row keeps its address" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" '"SW_PORT_TBL[1].PVID"')"
# odi-oss appends its odi-only keys after the last table block, before </Config>.
check "a scalar after a closed table Dir is kept" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" '"NTP_SERVER":"192.168.0.2"')"
# ORDER MATTERS. /api/defaults shares the values buffer, and it used to emit it
# without clearing -- so with no default files on the device it republished
# whatever /api/values had left there, and the page then labelled every key an
# image default. Asking for values first is what makes this test able to fail.
check "defaults does not republish the values buffer" '{}' \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/defaults")"
# The backup is the precondition for the one irreversible thing anyone does to
# this device, so it must contain the keys that cannot be regenerated.
check "the backup carries the identity keys" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")" 'GPON_SN')"
check "the backup is served as a download" yes \
	"$(err "$(curl -si -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")" 'Content-Disposition: attachment')"
check "the backup needs the credential" 401 \
	"$(code "http://127.0.0.1:$PORT/api/backup")"
# A cs store of ~37 KB, more than the old 24 KB buffer: the hs store after it
# was dropped without an error, so the identity keys read as empty.
echo 450 > /etc/config/padcs
check "a large cs store still leaves the hs store in the values" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values" | grep -o '"GPON_SN":"[^"]*"')" '"GPON_SN":"ODIX00000001"')"
check "and the odi-only keys at the end of the cs store" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values" | grep -o '"NTP_SERVER":"[^"]*"')" '"NTP_SERVER":"192.168.0.2"')"
check "and the backup carries the hs store" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/backup" | grep -o 'ODIX00000001')" 'ODIX00000001')"
# One that does not fit at all (~82 KB) is refused, never served cut.
echo 1000 > /etc/config/padcs
check "a store larger than the buffer is refused, not cut" 500 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/values")"
check "and says why" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" 'larger than confd can hold')"
check "a backup that would be cut is refused" 500 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")"
rm -f /etc/config/padcs
# A dump that failed or printed nothing is not a backup either. flash's error
# line comes down the same pipe as the store, so by byte count alone it passed
# for one, and an empty hs dump was accepted as it was.
echo hs > /etc/config/failstore
check "a backup whose hs dump failed is refused" 500 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")"
check "and the values are still served, so the page opens" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" '"VLAN_MANU_TAG_VID":"110"')"
echo cs > /etc/config/failstore
check "a backup whose cs dump failed is refused" 500 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")"
rm -f /etc/config/failstore
echo hs > /etc/config/emptystore
check "a backup whose hs dump is empty is refused" 500 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")"
rm -f /etc/config/emptystore
check "and with both dumps back the backup is served" 200 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/backup")"

echo "== diagnostics bundle"
# /api/diag runs the image /etc/scripts/diag-bundle.sh and streams the file it
# names. The real script is odi-oss; this stub stands in for its contract:
# argv[1] is the output path, exit 0 means the file is there. Its mode comes
# from a file because confd hands a child no environment.
check "no bundle script answers 501" 501 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/diag")"
mkdir -p /tmp/diag-src/odi-diag
echo "stub bundle" > /tmp/diag-src/odi-diag/MANIFEST.txt
tar -czf /tmp/diag-stub.tar.gz -C /tmp/diag-src odi-diag
cat > /etc/scripts/diag-bundle.sh <<'STUB'
#!/bin/sh
case "$(cat /tmp/diag-stub.mode 2>/dev/null)" in
fail) echo "diag-bundle: the bundle came to 3000000 bytes, over BUNDLE_MAX" >&2; exit 1 ;;
esac
cp /tmp/diag-stub.tar.gz "$1" && echo "$1"
STUB
chmod +x /etc/scripts/diag-bundle.sh
echo ok > /tmp/diag-stub.mode
check "the bundle needs the credential" 401 \
	"$(code "http://127.0.0.1:$PORT/api/diag")"
hdr=$(curl -s -u "$AUTH" -D - -o /tmp/diag-got.tar.gz "http://127.0.0.1:$PORT/api/diag")
check "the bundle is served as a download" yes \
	"$(err "$hdr" 'Content-Disposition: attachment; filename="odi-diag.tar.gz"')"
check "the bundle is gzip" yes "$(err "$hdr" 'Content-Type: application/gzip')"
check "the bundle arrives byte for byte" "$(md5sum < /tmp/diag-stub.tar.gz)" \
	"$(md5sum < /tmp/diag-got.tar.gz)"
check "the bundle file is removed after serving" gone \
	"$([ -e /tmp/odi-diag.tar.gz ] && echo present || echo gone)"
echo fail > /tmp/diag-stub.mode
check "a failed bundle answers 500" 500 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/diag")"
check "a failed bundle says why" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/diag")" 'over BUNDLE_MAX')"
rm -f /etc/scripts/diag-bundle.sh /tmp/diag-stub.mode /tmp/diag-stub.tar.gz /tmp/diag-got.tar.gz
rm -rf /tmp/diag-src

check "the OMCI feature bits are served" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/features")" '"feature":"ignore_conn_uniNode_check"')"
check "the build id is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"confd":')"
# No /proc/mtd here, so neither slot can be read: each must come back empty,
# never guessed, and the object must still be valid JSON around it.
check "the path confd was started from is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"exe":"build/confd"')"
check "an unreadable slot is reported empty, not guessed" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"slots":{"0":{},"1":{}}')"

echo "== firmware upload"
# The point of this route is that a 3 MB body reaches a file through a 16 KB
# request buffer. So the check uses a REAL multi-megabyte body and compares
# md5s end to end -- a small one would pass whether the streaming loop works or
# the whole thing still fits in one read.
# A real tar, not random bytes: the daemon looks for the ustar header and
# refuses anything else. One 3 MB member of random data gives a multi-megabyte
# body whose md5 can be compared end to end.
mkdir -p /tmp/payload.d
dd if=/dev/urandom of=/tmp/payload.d/payload bs=1024 count=3072 2>/dev/null
tar -cf /tmp/fake.tar -C /tmp/payload.d payload
rm -rf /tmp/payload.d
FAKE_BYTES=$(wc -c < /tmp/fake.tar | tr -d ' ')
# A small one for the checks that only need an upload to succeed.
mkdir -p /tmp/small.d
echo small > /tmp/small.d/small
tar -cf /tmp/small.tar -C /tmp/small.d small
rm -rf /tmp/small.d
SMALL_BYTES=$(wc -c < /tmp/small.tar | tr -d ' ')
LOCAL_MD5=$(md5sum /tmp/fake.tar | cut -d" " -f1)
UP=$(curl -s -u "$AUTH" -X POST --data-binary @/tmp/fake.tar \
	-H 'Content-Type: application/octet-stream' \
	"http://127.0.0.1:$PORT/api/upload")
check "a 3 MB image uploads" yes "$(err "$UP" '"ok":true')"
check "every byte arrives" yes "$(err "$UP" "\"bytes\":$FAKE_BYTES")"
check "and the file on disk is byte-identical" "$LOCAL_MD5" \
	"$(md5sum /tmp/img.tar 2>/dev/null | cut -d' ' -f1)"
check "the daemon reports that same md5" yes "$(err "$UP" "$LOCAL_MD5")"

# The guard is on the DECLARED length, tested before the file is opened and
# before a byte of body is read -- so /tmp cannot be filled by an upload that
# announces itself as too big for it.
#
# Declared 20 MB, body sixteen bytes. Sending a real oversized body instead
# made this flaky rather than wrong: the daemon rejects on the header and
# closes while curl is still sending, so curl is reset mid-send and reports 000
# instead of reading the 413. Separating the header from the body is what makes
# the check test the guard rather than the timing.
printf 'not an image at ' > /tmp/lie.bin
check "an upload declaring more than the limit is refused" 413 \
	"$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST \
	   -H 'Content-Length: 20000000' -H 'Content-Type: application/octet-stream' \
	   --data-binary @/tmp/lie.bin "http://127.0.0.1:$PORT/api/upload")"
check "and it wrote nothing" no \
	"$([ -f /tmp/img.tar ] && [ "$(wc -c < /tmp/img.tar)" -lt "$FAKE_BYTES" ] && echo yes || echo no)"
rm -f /tmp/lie.bin
check "an empty upload is refused" 413 \
	"$(code -u "$AUTH" -X POST -H 'Content-Type: application/octet-stream' \
	   "http://127.0.0.1:$PORT/api/upload")"
check "an upload needs the credential" 401 \
	"$(code -X POST --data-binary @/tmp/fake.tar "http://127.0.0.1:$PORT/api/upload")"
check "a cross-origin upload is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST \
	   --data-binary @/tmp/fake.tar "http://127.0.0.1:$PORT/api/upload")"

# Every OTHER route must still refuse a body it cannot hold whole. read_request
# used to error on one itself; now it reports one, and this is what keeps that
# from quietly becoming a truncated config write.
#
# 20 KB, just over the 16 KB request buffer (src/buffers.h), not the 3 MB file:
# the daemon answers 413 and closes while the client is still sending, so with
# a large body curl is reset mid-send and never reads the status at all. That
# is correct of the server and useless as an assertion. 64 KB still lost that
# race on a CI runner (v1.0.2); 20 KB fits in the socket buffers, so the send
# finishes first, which tests the rule rather than TCP.
dd if=/dev/urandom of=/tmp/big.bin bs=1024 count=20 2>/dev/null
check "an oversized body on another route is still 413" 413 \
	"$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST \
	   --data-binary @/tmp/big.bin "http://127.0.0.1:$PORT/api/config")"
# And nothing was written from the part of it that did arrive.
check "and nothing from it was written" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/values")" '"LAN_IP_ADDR":"192.168.1.1"')"
rm -f /tmp/fake.tar /tmp/big.bin

# The daemon refuses to write the partition it is running, independently of
# whatever the page offers. The nv stub says sw_active=0.
check "writing the running partition is refused" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'action=write&partition=0' "http://127.0.0.1:$PORT/api/firmware")" 'that is the partition this stick is running')"
check "a bad partition is still refused" 400 \
	"$(code -u "$AUTH" -X POST -d 'action=write&partition=9' "http://127.0.0.1:$PORT/api/firmware")"

# Commit. It is `nv commit <slot>` (both environment copies, read back, refused
# for a slot that is not running), never a plain setenv of sw_commit, and the
# slot state the exporter and the banner read is rewritten afterwards.
echo "== commit"
fw() { curl -s -u "$AUTH" -X POST -d "$1" "http://127.0.0.1:$PORT/api/firmware"; }
yn() { case "$1" in *"$2"*) echo yes ;; *) echo no ;; esac; }
rm -f /tmp/nv.calls /tmp/slot-state.calls /tmp/nv.refuse /tmp/nv.vendor /tmp/slot-state.fail
r=$(fw 'action=commit&partition=0')
check "a commit succeeds" yes "$(err "$r" '"ok":true')"
check "and says the slot state was refreshed" yes "$(err "$r" '"refreshed":true')"
check "through nv commit" yes "$(grep -qx 'commit 0' /tmp/nv.calls && echo yes || echo no)"
check "not a one-copy setenv" no "$(yn "$(cat /tmp/nv.calls)" 'setenv sw_commit')"
check "and slot-state.sh ran after it" 1 "$(wc -l < /tmp/slot-state.calls | tr -d ' ')"
touch /tmp/slot-state.fail
check "a failed refresh is reported, the commit still stands" yes \
	"$(err "$(fw 'action=commit&partition=0')" '"ok":true,"note":"committed","refreshed":false')"
rm -f /tmp/slot-state.fail /tmp/slot-state.calls
touch /tmp/nv.refuse
r=$(fw 'action=commit&partition=0')
check "a refusal by nv is an error with nv's reason" yes "$(err "$r" '"ok":false,"error":"commit 0: that is not the slot this kernel was booted from')"
check "and slot-state.sh is not run for it" no "$(test -e /tmp/slot-state.calls && echo yes || echo no)"
rm -f /tmp/nv.refuse /tmp/nv.calls
# Only the running partition is committed (the stub runs 0), on every path.
r=$(fw 'action=commit&partition=1')
check "the other partition is refused" yes "$(err "$r" '"ok":false,"error":"only the running partition can be committed, and partition 1 is not')"
check "and nv was not asked to commit or set anything" no "$(test -e /tmp/nv.calls && grep -qE 'commit|setenv' /tmp/nv.calls && echo yes || echo no)"
echo 1 > /tmp/nv.active
check "the other partition is accepted once it is the running one" yes "$(err "$(fw 'action=commit&partition=1')" '"ok":true,"note":"committed"')"
check "through nv commit 1" yes "$(grep -qx 'commit 1' /tmp/nv.calls && echo yes || echo no)"
rm -f /tmp/nv.active /tmp/nv.calls /tmp/slot-state.calls
touch /tmp/nv.noactive
r=$(fw 'action=commit&partition=0')
check "an unreadable running partition refuses the commit" yes "$(err "$r" 'cannot tell which partition this stick is running')"
check "and nv was not asked to commit or set anything" no "$(test -e /tmp/nv.calls && grep -qE 'commit|setenv' /tmp/nv.calls && echo yes || echo no)"
rm -f /tmp/nv.noactive /tmp/nv.calls
touch /tmp/nv.vendor
r=$(fw 'action=commit&partition=1')
check "the stock nv fallback refuses the other partition too" yes "$(err "$r" 'only the running partition can be committed')"
check "and never ran setenv sw_commit" no "$(test -e /tmp/nv.calls && grep -q 'setenv sw_commit' /tmp/nv.calls && echo yes || echo no)"
rm -f /tmp/nv.calls
r=$(fw 'action=commit&partition=0')
check "the stock nv has no commit verb: one-copy setenv, and it says so" yes "$(err "$r" 'one environment copy')"
check "that setenv is what ran" yes "$(err "$(cat /tmp/nv.calls)" 'setenv sw_commit 0')"
rm -f /tmp/nv.vendor /tmp/nv.calls /tmp/slot-state.calls
touch /tmp/nv.crash
r=$(fw 'action=commit&partition=0')
check "an nv that fails without its usage text is a failed commit" yes "$(err "$r" '"ok":false,"error":"nv commit failed"')"
check "and no one-copy setenv is tried for it" no "$(test -e /tmp/nv.calls && grep -q 'setenv sw_commit' /tmp/nv.calls && echo yes || echo no)"
rm -f /tmp/nv.crash /tmp/nv.calls /tmp/slot-state.calls
check "a bad partition is refused before nv is asked" 400 \
	"$(code -u "$AUTH" -X POST -d 'action=commit&partition=9' "http://127.0.0.1:$PORT/api/firmware")"
check "and nv was not run" no "$(test -e /tmp/nv.calls && echo yes || echo no)"

# Try. A slot is armed only when its kernel partition holds a uImage the
# bootloader would boot (src/uimage.h); here there is no /proc/mtd partition
# named k0 or k1, so both are refused, and nv is never asked to write
# sw_tryactive. The CRC logic itself is scripts/uimage-test.sh.
echo "== try"
rm -f /tmp/nv.calls
r=$(fw 'action=try&partition=1')
check "a trial of a slot with no bootable kernel is refused" yes "$(err "$r" '"ok":false,"error":"partition 1 does not hold a kernel the bootloader would boot')"
check "and nv was not asked to arm it" no "$(test -e /tmp/nv.calls && grep -q 'sw_tryactive' /tmp/nv.calls && echo yes || echo no)"
check "a bad partition is refused before anything is read" 400 \
	"$(code -u "$AUTH" -X POST -d 'action=try&partition=9' "http://127.0.0.1:$PORT/api/firmware")"
rm -f /tmp/nv.calls

# A background write, as odi-oss fwu_starter.sh leaves it: the state and the
# log are reported so the page can follow it.
sleep 300 &
LIVE1=$!
printf 'running %s 1\n' "$LIVE1" > /tmp/fwu.state
printf 'fwu: slot 1 -> kernel /dev/mtd6\nfwu: erasing /dev/mtd6\n' > /tmp/fwu.log
check "a running write is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" "\"write\":{\"state\":\"running\",\"pid\":\"$LIVE1\",\"slot\":\"1\",\"rc\":\"\"")"
check "with the end of its log" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" 'erasing /dev/mtd6')"
kill "$LIVE1" 2>/dev/null || true
wait "$LIVE1" 2>/dev/null || true
printf 'failed 4242 1 3\n' > /tmp/fwu.state
check "and a failed one with its exit code" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"state":"failed","pid":"4242","slot":"1","rc":"3"')"
# The pid in the state file is the supervising shell of fwu_starter.sh; what
# every process of a write shares is the writer lock (/tmp/fwu.state.lock, fd 9,
# inherited). A write is running while that pid is alive OR the lock is held.
# The lock is held here by a helper process, as fwu.sh would hold it after its
# supervisor was killed. The reboot is only posted where it is refused: an
# accepted one would reboot the machine this runs on.
FLOCKER=
holdlock() {
	: >> /tmp/fwu.state.lock
	if python3 -c 'import fcntl' 2>/dev/null; then
		python3 -c 'import fcntl,time
f = open("/tmp/fwu.state.lock", "a")
fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
time.sleep(300)' &
	else
		flock -x /tmp/fwu.state.lock sleep 299 &
	fi
	FLOCKER=$!
	sleep 1
}
freelock() {
	if [ -n "$FLOCKER" ]; then
		kill "$FLOCKER" 2>/dev/null || true
		wait "$FLOCKER" 2>/dev/null || true
	fi
	FLOCKER=
}
fwget() { curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware"; }
sleep 0.1 &
DEAD=$!
wait "$DEAD" 2>/dev/null || true
rm -f /tmp/fwu.state.lock

# No lock file (an older image): the pid alone decides. A dead one with no
# recorded result is unknown, not failed: a --foreground write leaves exactly
# this behind when it finishes, and a killed supervisor may have left a writer.
printf 'running %s 1\n' "$DEAD" > /tmp/fwu.state
r=$(fwget)
check "a running state, dead pid, no lock: not reported as running" no "$(yn "$r" '"state":"running"')"
check "and not as failed" no "$(yn "$r" '"state":"failed"')"
check "but as unknown, with its slot and no exit code" yes "$(err "$r" "\"state\":\"unknown\",\"pid\":\"$DEAD\",\"slot\":\"1\",\"rc\":\"\"")"
# The result was recorded after all: it is what is reported.
printf 'ok %s 1\n' "$DEAD" > /tmp/fwu.state
check "an ok state with a dead pid is reported as ok" yes "$(err "$(fwget)" "\"state\":\"ok\",\"pid\":\"$DEAD\"")"

# The pid is gone but the lock is held: the writer is still at work.
printf 'running %s 1\n' "$DEAD" > /tmp/fwu.state
holdlock
r=$(fwget)
check "dead pid, lock held: still reported as running" yes "$(err "$r" '"state":"running"')"
check "a reboot is refused" 409 "$(code -u "$AUTH" -X POST -d 'action=reboot&partition=' "$U/api/firmware")"
check "and an upload is refused" 409 "$(code -u "$AUTH" -X POST --data-binary 'x' "$U/api/upload")"
freelock
check "the lock freed, the same state is unknown" yes "$(err "$(fwget)" '"state":"unknown"')"
check "and the lock probe took nothing: it can be taken again" yes \
	"$(holdlock; if kill -0 "$FLOCKER" 2>/dev/null; then echo yes; else echo no; fi; freelock)"
sleep 300 &
LIVE2=$!
printf 'running %s 1\n' "$LIVE2" > /tmp/fwu.state
check "and one with a live writer still is running" yes \
	"$(err "$(fwget)" '"state":"running"')"
kill "$LIVE2" 2>/dev/null || true
wait "$LIVE2" 2>/dev/null || true
rm -f /tmp/fwu.state.lock
rm -f /tmp/fwu.state /tmp/fwu.log
check "no state file, no write field" no \
	"$(case "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" in *'"write"'*) echo yes ;; *) echo no ;; esac)"

echo "== applying"
# /etc/scripts/apply.sh does the work on odi-oss; the stub echoes what it was
# asked, so the argv the route builds is what is checked.
cat > /etc/scripts/apply.sh <<'APPLY'
#!/bin/sh
echo "apply.sh: $1"
[ "$1" = omci ] && [ -f /tmp/apply-fail ] && exit 1
exit 0
APPLY
chmod +x /etc/scripts/apply.sh
check "apply network runs apply.sh network" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=network' "http://127.0.0.1:$PORT/api/apply")" '"ok":true,"applied":true,"output":"apply.sh: network')"
check "apply omci runs apply.sh omci" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")" 'apply.sh: omci')"
check "apply syslog runs apply.sh syslog" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=syslog' "http://127.0.0.1:$PORT/api/apply")" 'apply.sh: syslog')"
check "apply ntp runs apply.sh ntp" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=ntp' "http://127.0.0.1:$PORT/api/apply")" 'apply.sh: ntp')"
check "apply igmp runs apply.sh igmp" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=igmp' "http://127.0.0.1:$PORT/api/apply")" 'apply.sh: igmp')"
check "apply sfp runs apply.sh sfp" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=sfp' "http://127.0.0.1:$PORT/api/apply")" 'apply.sh: sfp')"
touch /tmp/apply-fail
check "a failing apply is reported as not applied" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")" '"ok":false')"
rm -f /tmp/apply-fail
check "an unknown action is refused" 400 \
	"$(code -u "$AUTH" -X POST -d 'what=reboot' "http://127.0.0.1:$PORT/api/apply")"
check "applying needs the credential" 401 \
	"$(code -X POST -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")"
check "a cross-origin apply is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST -d 'what=omci' "http://127.0.0.1:$PORT/api/apply")"
rm -f /etc/scripts/apply.sh
check "without apply.sh the network action is refused" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=network' "http://127.0.0.1:$PORT/api/apply")" 'reboot to apply')"

check "without apply.sh the syslog action is refused, not turned into an omci restart" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'what=syslog' "http://127.0.0.1:$PORT/api/apply")" 'reboot to apply')"

echo "== switch files"
check "the ONU identity switch starts off" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"switches":{"omci-identity.on":false,"confd.setup":false,"update-check.off":false}')"
check "it can be turned on" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'name=omci-identity.on&on=1' "http://127.0.0.1:$PORT/api/switch")" '"ok":true,"on":true')"
check "which creates the file" yes "$([ -f /etc/config/omci-identity.on ] && echo yes)"
check "and is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"switches":{"omci-identity.on":true,"confd.setup":false,"update-check.off":false}')"
check "and off again" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'name=omci-identity.on&on=0' "http://127.0.0.1:$PORT/api/switch")" '"ok":true,"on":false')"
check "which removes it" no "$([ -f /etc/config/omci-identity.on ] && echo yes || echo no)"
for bad in 'name=confd.auth&on=0' 'name=../confd.auth&on=0' 'name=omci-identity.on&on=2' 'name=omci-identity.on'; do
	check "switch refuses $bad" 400 \
		"$(code -u "$AUTH" -X POST -d "$bad" "http://127.0.0.1:$PORT/api/switch")"
done
check "the credential file survived every refusal" yes "$([ -f /etc/config/confd.auth ] && echo yes)"

# The two development files, plain reads in /api/firmware: confirm-arp is the
# address (absent without the file, "" when it holds none), breadcrumbs.on is
# true only when present. Nothing from the file reaches the JSON but a valid
# dotted address.
echo "== development files"
fwj() { curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware"; }
rm -f /etc/config/confirm-arp /etc/config/breadcrumbs.on
check "no dev_confirm_arp without the file" no "$(yn "$(fwj)" 'dev_confirm_arp')"
check "no dev_breadcrumbs without the file" no "$(yn "$(fwj)" 'dev_breadcrumbs')"
echo 192.168.1.2 > /etc/config/confirm-arp
check "confirm-arp reports its address" yes "$(err "$(fwj)" '"dev_confirm_arp":"192.168.1.2"')"
printf '  10.0.0.254 \n\n' > /etc/config/confirm-arp
check "blanks around the address are dropped" yes "$(err "$(fwj)" '"dev_confirm_arp":"10.0.0.254"')"
: > /etc/config/confirm-arp
check "an empty file is present without an address" yes "$(err "$(fwj)" '"dev_confirm_arp":""')"
for bad in 'router' '192.168.1' '192.168.1.256' '192.168.01.2' '1.2.3.4.5' '1.2.3.4 x' '1.2.3.4"}'; do
	printf '%s\n' "$bad" > /etc/config/confirm-arp
	check "confirm-arp holding '$bad' is present without an address" yes "$(err "$(fwj)" '"dev_confirm_arp":""')"
done
rm -f /etc/config/confirm-arp
touch /etc/config/breadcrumbs.on
check "breadcrumbs.on is reported" yes "$(err "$(fwj)" '"dev_breadcrumbs":true')"
check "and /api/init carries it too" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/init")" '"dev_breadcrumbs":true')"
rm -f /etc/config/breadcrumbs.on
check "and it is gone when the file is" no "$(yn "$(fwj)" 'dev_breadcrumbs')"

# The setup wizard marker (web/wizard.js): the page opens the wizard on a
# stick that has none, so it has to be absent by default, settable, kept on
# the config partition, there again after the daemon restarts, and removable.
echo "== setup marker"
fw() { curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware"; }
sw() { curl -s -u "$AUTH" -X POST -d "$1" "http://127.0.0.1:$PORT/api/switch"; }
check "the setup marker is absent by default" yes "$(err "$(fw)" '"confd.setup":false,')"
check "it can be set" yes "$(err "$(sw 'name=confd.setup&on=1')" '"ok":true,"on":true')"
check "which creates the file next to confd.auth" yes "$([ -f /etc/config/confd.setup ] && echo yes)"
check "and is reported" yes "$(err "$(fw)" '"confd.setup":true,')"
kill $DAEMON; wait $DAEMON 2>/dev/null || true
qemu-mips-static "$BIN" "$PORT" "$HWMON" &
DAEMON=$!
for _ in $(seq 40); do
	curl -fsS -u "$AUTH" -o /dev/null "http://127.0.0.1:$PORT/api/schema" && break
	sleep 0.25
done
check "it is still set after the daemon restarts" yes "$(err "$(fw)" '"confd.setup":true,')"
check "the identity switch is independent of it" yes "$(err "$(fw)" '"omci-identity.on":false,')"
check "it can be removed" yes "$(err "$(sw 'name=confd.setup&on=0')" '"ok":true,"on":false')"
check "which removes the file" no "$([ -f /etc/config/confd.setup ] && echo yes || echo no)"
for bad in 'name=confd.setup&on=2' 'name=confd.setup' 'name=confd.setup.x&on=1' 'name=confd.setup&on=' 'name=CONFD.SETUP&on=1'; do
	check "the marker route refuses $bad" 400 \
		"$(code -u "$AUTH" -X POST -d "$bad" "http://127.0.0.1:$PORT/api/switch")"
done
check "no marker was written by a refusal" no "$([ -f /etc/config/confd.setup ] && echo yes || echo no)"
check "the marker needs the credential" 401 \
	"$(code -X POST -d 'name=confd.setup&on=1' "http://127.0.0.1:$PORT/api/switch")"
check "and refuses a cross-site origin" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST -d 'name=confd.setup&on=1' "http://127.0.0.1:$PORT/api/switch")"
check "no marker after those either" no "$([ -f /etc/config/confd.setup ] && echo yes || echo no)"

# What the wizard sends on its last step: the serial, the PLOAM password as
# the 20 hex digits it converts to, the LOID pairs, the VLAN keys and the
# identity confirmation, all in one write. Every key is accepted and read
# back, and the answer names exactly those keys and no other.
echo "== setup wizard write"
wz=$(curl -s -u "$AUTH" -X POST --data 'GPON_SN=ODIX00000001&GPON_PLOAM_PASSWD=61626300000000000000&LOID=lo1&LOID_OLD=lo1&LOID_PASSWD=pw1&LOID_PASSWD_OLD=pw1&VLAN_CFG_TYPE=1&VLAN_MANU_MODE=1&VLAN_MANU_TAG_VID=110&VLAN_MANU_TAG_PRI=3&_confirm=identity' "http://127.0.0.1:$PORT/api/config")
check "the wizard write is accepted key by key, exactly the ten it sent" 10 "$(printf '%s' "$wz" | grep -o '"ok":true' | wc -l | tr -d ' ')"
check "and nothing in it failed" clean "$(case "$wz" in *'"ok":false'*) echo failed ;; *) echo clean ;; esac)"
check "the PLOAM password is stored as the converted hex" yes "$(err "$wz" '"name":"GPON_PLOAM_PASSWD","ok":true,"value":"61626300000000000000"')"
check "the same write without the identity confirmation is refused for the identity keys" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'GPON_SN=ODIX00000001&GPON_PLOAM_PASSWD=61626300000000000000' "http://127.0.0.1:$PORT/api/config")" 'confirm')"
check "a PLOAM password in the text form is refused by the store: the page converts it" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'GPON_PLOAM_PASSWD=abc&_confirm=identity' "http://127.0.0.1:$PORT/api/config")" 'not valid for its type')"

# The wizard's SSH key step posts one key to /api/sshkeys, as System, Access
# does: a good key is appended, a bad one is refused, and a key already in the
# file is refused, not appended twice.
rm -f /etc/config/dropbear.d/authorized_keys
check "wizard ssh key: a valid key is appended" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")" '"ok":true')"
check "wizard ssh key: the file holds that one line" "1 600" \
	"$(wc -l < /etc/config/dropbear.d/authorized_keys | tr -d ' ') $(stat -c '%a' /etc/config/dropbear.d/authorized_keys)"
check "wizard ssh key: the same key again is refused" 400 \
	"$(code -u "$AUTH" -X POST --data-urlencode "key=$K1" "http://127.0.0.1:$PORT/api/sshkeys")"
check "wizard ssh key: a bad key is refused" 400 \
	"$(code -u "$AUTH" -X POST --data-urlencode 'key=ssh-ed25519 notbase64!' "http://127.0.0.1:$PORT/api/sshkeys")"
check "wizard ssh key: and nothing was appended by either" 1 "$(wc -l < /etc/config/dropbear.d/authorized_keys | tr -d ' ')"
rm -f /etc/config/dropbear.d/authorized_keys

echo "== update check switch"
# The update check runs in the browser; the stick only keeps whether it is off,
# for every browser. On by default, so the file means off.
check "the update check starts on" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"update-check.off":false}')"
check "it can be turned off" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'name=update-check.off&on=1' "http://127.0.0.1:$PORT/api/switch")" '"ok":true,"on":true')"
check "which creates the file" yes "$([ -f /etc/config/update-check.off ] && echo yes)"
check "and is reported" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"update-check.off":true}')"
check "the identity switch is untouched by it" no "$([ -f /etc/config/omci-identity.on ] && echo yes || echo no)"
# The state is a file on the config partition, so a new daemon reads it back.
kill "$DAEMON"; wait "$DAEMON" 2>/dev/null || true
qemu-mips-static "$BIN" "$PORT" "$HWMON" &
DAEMON=$!
for _ in $(seq 40); do
	curl -fsS -u "$AUTH" -o /dev/null "http://127.0.0.1:$PORT/api/schema" && break
	sleep 0.25
done
check "it survives a restart of confd" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/firmware")" '"update-check.off":true}')"
check "and turned on again" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'name=update-check.off&on=0' "http://127.0.0.1:$PORT/api/switch")" '"ok":true,"on":false')"
check "which removes the file" no "$([ -f /etc/config/update-check.off ] && echo yes || echo no)"
check "update-check.off refuses a bad value" 400 \
	"$(code -u "$AUTH" -X POST -d 'name=update-check.off&on=2' "http://127.0.0.1:$PORT/api/switch")"

echo "== tools"
# Ping takes IPv4 literals and nothing else. Not fussiness: this server is
# serial, so a hostname means a DNS lookup on a device with no route to a
# resolver, and that hangs rather than failing -- taking the whole UI with it.
# shellcheck disable=SC2016  # the $(id) case must reach the daemon unexpanded
for bad in 'host=example.com' 'host=1.2.3' 'host=1.2.3.4.5' 'host=' \
           'host=$(id)' 'host=1.2.3.4;id' 'nothost=1.2.3.4'; do
	check "ping refuses $bad" 400 \
		"$(code -u "$AUTH" -X POST -d "$bad" "http://127.0.0.1:$PORT/api/ping")"
done
check "ping accepts an IPv4 literal" 200 \
	"$(code -u "$AUTH" -X POST -d 'host=192.0.2.1' "http://127.0.0.1:$PORT/api/ping")"
# There is no /bin/ping in the toolchain container, which makes this the case
# worth pinning: a missing binary must not read as "no reply", or it sends you
# to look at the network instead of at the image.
check "a missing ping says so, rather than 'no reply'" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'host=192.0.2.1' "http://127.0.0.1:$PORT/api/ping")" 'no ping in this image')"
check "the kernel log comes back" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/log")" '"truncated"')"
check "and it is not empty" yes \
	"$([ "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/log" | wc -c)" -gt 200 ] && echo yes || echo no)"
check "reading it twice gives the same buffer" yes \
	"$([ "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/log")" = "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/log")" ] && echo yes || echo no)"

echo "== the switch MAC table"
# Its own route, not another line in the status scrape: the status buffer is
# 16 KB and the counter dump alone is 5.9 KB, so a few hundred learned
# addresses would push the optics out of the response.
check "the MAC table is read from diag" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/l2")" '78:54:2E:07:64:63')"
# It must come from the ARGV path. diag spins forever when this command arrives
# on stdin, which hung the whole daemon on a real stick.
check "and via argv, not stdin" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/l2")" 'LUT address')"
check "and it is not truncated at this size" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/l2")" '"truncated":false')"
# Never covered before, because there was no diag stub: the status scrape puts
# every question in on one stdin and splits the answers on the prompt.
check "the status scrape batches its commands" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/status")" 'Operation State(O5)')"
check "and every command in the batch answers" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/status")" 'Rx Power')"
check "the bias current is in the batch" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/status")" 'Bias Current')"
check "and the uptime rides along, in whole seconds" 1 \
	"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/status" | grep -cE '"uptime":"[0-9]+"')"
check "it needs the credential" 401 \
	"$(code "http://127.0.0.1:$PORT/api/l2")"

echo "== resetting the service config"
# flash default cs, not flash_eraseall: the hs store holds GPON_SN, MAC_KEY and
# ELAN_MAC_ADDR, and erasing the partition is what ends sticks in the field.
check "a reset without the confirm is refused" 400 \
	"$(code -u "$AUTH" -X POST "http://127.0.0.1:$PORT/api/reset")"
check "a wrong confirm is refused" 400 \
	"$(code -u "$AUTH" -X POST -d '_confirm=yes' "http://127.0.0.1:$PORT/api/reset")"
check "a confirmed reset runs flash default cs" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d '_confirm=reset' "http://127.0.0.1:$PORT/api/reset")" 'Reset CS to default configuration success')"
check "and reports it succeeded" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d '_confirm=reset' "http://127.0.0.1:$PORT/api/reset")" '"ok":true')"
# The hs store is not reachable from here at all. The route hardcodes cs, so a
# store parameter must not be able to steer it.
check "the store cannot be steered to hs" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST -d 'store=hs&_confirm=reset' "http://127.0.0.1:$PORT/api/reset")" 'Reset CS to default')"
check "a reset needs the credential" 401 \
	"$(code -X POST -d '_confirm=reset' "http://127.0.0.1:$PORT/api/reset")"
check "a cross-origin reset is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST -d '_confirm=reset' "http://127.0.0.1:$PORT/api/reset")"

echo "== the OMCI MIB route"
# Everything reaching omcicli comes off a query string, so the checks that
# matter are the ones that keep a request from choosing the command. There is
# no shell in this daemon -- run_to_buf_ex execve()s directly -- but the domain
# check is what makes a bad argument fail as "not a MIB table" here instead of
# somewhere further in.
check "a class id is read" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=84")" 'VlanTagFilterData')"
check "the entity id reaches the command" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=84&entity=0x04")" 'ARGV: mib get 84 0x04')"
check "a table name is accepted too" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=VlanTagFilterData")" 'ARGV: mib get VlanTagFilterData')"
# `omcicli get tables` is refused, not proxied. On a stick it returns zero
# bytes and leaves the MIB service unable to answer until omci_app restarts --
# so the route that exists to read the MIB must not be able to break it. The
# names ship as data instead.
check "get tables is refused, not run" 400 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=tables")"
check "and the reason says why" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=tables")" 'wedges the MIB service')"
check "an allowlisted dump is read" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=dump&what=srvflow")" 'ARGV: dump srvflow')"
# `omcicli state` is a verb of the odi-oss omcid; this container has no
# /proc/odi_gpon/status, as a stock slot has none, so it is refused before
# anything runs, and the link check leaves the stages that need it unknown.
check "state is refused without the odi-oss driver" 400 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=state")"
check "and says why" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=state")" 'needs the odi-oss omcid')"

for bad in 'cmd=me&me=84;reboot' 'cmd=me&me=../../etc/passwd' 'cmd=me&me=-rf' \
           'cmd=me&me=84%20171' 'cmd=me' 'cmd=dump&what=conn;id' 'cmd=dump' \
           'cmd=set&me=84' ''; do
	check "refuses ?$bad" 400 \
		"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?$bad")"
done
# Classes that hold OLT-provisioned secrets are refused here, whatever omcicli
# prints: the stub above prints the bytes unmasked, as an older omcid does.
for c in 148 0148 157 307 65530 LoIdAuth loidauth AuthSecMethod authsecmethod LargeString all; do
	check "class $c is refused" 403 \
		"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=$c")"
	check "class $c never shows the secret bytes" none \
		"$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=$c&entity=0x01" | grep -c SECRET1 | sed 's/^0$/none/')"
done
# No way to pass an extra argument: a flag as the class, a second word in it,
# or a stray query field never reaches omcicli.
for bad in 'me=--secrets' 'me=148%20--secrets' 'me=84%20--secrets' 'me=84&entity=--secrets'; do
	check "refuses ?cmd=me&$bad" 400 \
		"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&$bad")"
done
check "a stray secrets field does not reach omcicli" yes \
	"$(err "$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=84&secrets=1&--secrets=1&args=--secrets" | grep -c -e '--secrets' | sed 's/^0$/clean/')" clean)"
check "a non-hex entity is refused" 400 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=84&entity=zz")"

# The phone view. GET is the masked view and its argv is fixed: no field can
# add --secrets, and the stub's password never appears in it.
echo "== voip"
V="http://127.0.0.1:$PORT/api/voip"
check "GET /api/voip needs a credential" 401 "$(code "$V")"
check "GET /api/voip answers" 200 "$(code -u "$AUTH" "$V")"
check "GET /api/voip runs omcicli voip, no flag" yes \
	"$(err "$(curl -s -u "$AUTH" "$V")" 'ARGV: voip\u000a')"
check "GET /api/voip shows the masked view" yes \
	"$(err "$(curl -s -u "$AUTH" "$V")" 'MASKED-5678')"
check "GET /api/voip never prints the password" none \
	"$(curl -s -u "$AUTH" "$V" | grep -c SIPPASS9 | sed 's/^0$/none/')"
check "GET /api/voip ignores a stray secrets field" none \
	"$(curl -s -u "$AUTH" "$V?secrets=1&--secrets=1" | grep -c -e SIPPASS9 -e '--secrets' | sed 's/^0$/none/')"
check "GET /api/voip says ok" yes "$(err "$(curl -s -u "$AUTH" "$V")" '"ok":true')"
S="$V/secrets"
check "secrets: GET is not a route" 404 "$(code -u "$AUTH" "$S")"
check "secrets: needs a credential" 401 "$(code -X POST --data 'password=s3cret' "$S")"
check "secrets: no password in the body is refused" 400 "$(code -u "$AUTH" -X POST --data 'x=1' "$S")"
check "secrets: a wrong password is refused" 403 "$(code -u "$AUTH" -X POST --data 'password=nope' "$S")"
check "secrets: a wrong password shows nothing" none \
	"$(curl -s -u "$AUTH" -X POST --data 'password=nope' "$S" | grep -c SIPPASS9 | sed 's/^0$/none/')"
check "secrets: a prefix of the password is refused" 403 "$(code -u "$AUTH" -X POST --data 'password=s3cre' "$S")"
check "secrets: a longer password is refused" 403 "$(code -u "$AUTH" -X POST --data 'password=s3cretx' "$S")"
check "secrets: a cross-site POST is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST --data 'password=s3cret' "$S")"
check "secrets: the right password shows them" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'password=s3cret' "$S")" 'password SIPPASS9')"
check "secrets: the answer is not cached" yes \
	"$(err "$(curl -s -i -u "$AUTH" -X POST --data 'password=s3cret' "$S")" 'Cache-Control: no-store')"
# The factory credential is public: it does not unlock secrets.
mv /etc/config/confd.auth /etc/config/confd.auth.kept
check "secrets: refused while the factory password is in force" 403 \
	"$(code -u admin:admin -X POST --data 'password=admin' "$S")"
mv /etc/config/confd.auth.kept /etc/config/confd.auth
# No omcicli: 503, and no body to leak.
mv /bin/omcicli /bin/omcicli.kept
check "secrets: 503 when omcicli is missing" 503 \
	"$(code -u "$AUTH" -X POST --data 'password=s3cret' "$S")"
check "GET /api/voip says so when omcicli is missing" yes \
	"$(err "$(curl -s -u "$AUTH" "$V")" 'no omcicli in this image')"
mv /bin/omcicli.kept /bin/omcicli

# The router's report of its SIP state: a port and a state word, nothing else.
echo "== voip status"
R="$V/status"
RF=/var/run/voip-line-status
mkdir -p /var/run
rm -f "$RF" "$RF.new"
check "status: GET needs a credential" 401 "$(code "$R")"
check "status: POST needs a credential" 401 "$(code -X POST --data 'port=1&state=registered' "$R")"
check "status: GET with nothing reported holds no port" yes \
	"$(err "$(curl -s -u "$AUTH" "$R")" '"ports":[]')"
check "status: no state is refused" 400 "$(code -u "$AUTH" -X POST --data 'port=1' "$R")"
check "status: an unknown state is refused" 400 "$(code -u "$AUTH" -X POST --data 'port=1&state=ringing' "$R")"
check "status: a state with a prefix of a word is refused" 400 "$(code -u "$AUTH" -X POST --data 'port=1&state=registere' "$R")"
check "status: port 0 is refused" 400 "$(code -u "$AUTH" -X POST --data 'port=0&state=registered' "$R")"
check "status: port 3 is refused" 400 "$(code -u "$AUTH" -X POST --data 'port=3&state=registered' "$R")"
check "status: port 11 is refused" 400 "$(code -u "$AUTH" -X POST --data 'port=11&state=registered' "$R")"
check "status: no port is refused" 400 "$(code -u "$AUTH" -X POST --data 'state=registered' "$R")"
check "status: a refused report writes nothing" none "$([ -e "$RF" ] && echo there || echo none)"
check "status: a cross-site POST is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST --data 'port=1&state=registered' "$R")"
mv /etc/config/confd.auth /etc/config/confd.auth.kept
check "status: refused while the factory password is in force" 403 \
	"$(code -u admin:admin -X POST --data 'port=1&state=registered' "$R")"
mv /etc/config/confd.auth.kept /etc/config/confd.auth
check "status: still nothing written" none "$([ -e "$RF" ] && echo there || echo none)"
check "status: a report is accepted" 200 \
	"$(code -u "$AUTH" -X POST --data 'port=1&state=registered&username=bobsip&password=SIPPASS9&number=5511999990000' "$R")"
check "status: the file holds the port, the state and the uptime, nothing else" 1 \
	"$(grep -cE '^LINE1=registered [0-9]+$' "$RF")"
check "status: and only that line" 1 "$(wc -l < "$RF" | tr -d ' ')"
check "status: no SIP value reached the file" none \
	"$(grep -c -e bobsip -e SIPPASS9 -e 5511999990000 "$RF" | sed 's/^0$/none/')"
check "status: no temporary file is left" none "$([ -e "$RF.new" ] && echo there || echo none)"
check "status: the second port keeps the first" 200 \
	"$(code -u "$AUTH" -X POST --data 'port=2&state=failed_auth' "$R")"
check "status: both lines are held" 2 "$(grep -cE '^LINE[12]=[a-z_]+ [0-9]+$' "$RF")"
check "status: GET lists port 1" yes "$(err "$(curl -s -u "$AUTH" "$R")" '"port":1,"state":"registered","age":')"
check "status: GET lists port 2" yes "$(err "$(curl -s -u "$AUTH" "$R")" '"port":2,"state":"failed_auth","age":')"
check "status: GET says the TTL" yes "$(err "$(curl -s -u "$AUTH" "$R")" '"ttl":300')"
check "status: the longest state word is accepted" 200 \
	"$(code -u "$AUTH" -X POST --data 'port=1&state=failed_invite_timeout' "$R")"
check "status: and stored whole" 1 "$(grep -c '^LINE1=failed_invite_timeout [0-9]*$' "$RF")"
check "status: an invite failure word is accepted" 200 \
	"$(code -u "$AUTH" -X POST --data 'port=1&state=failed_invite_auth' "$R")"
check "status: a truncated invite word is refused" 400 \
	"$(code -u "$AUTH" -X POST --data 'port=1&state=failed_invite' "$R")"
check "status: a new report replaces the port, not the others" 200 \
	"$(code -u "$AUTH" -X POST --data 'port=1&state=none' "$R")"
check "status: port 1 is replaced" 1 "$(grep -c '^LINE1=none ' "$RF")"
check "status: port 2 is kept" 1 "$(grep -c '^LINE2=failed_auth ' "$RF")"
printf 'LINE1=registered 99999999\nLINE2=garbage\nLINE1x=1\n' > "$RF"
check "status: a stamp from the future and a malformed line are not listed" yes \
	"$(err "$(curl -s -u "$AUTH" "$R")" '"ports":[]')"
rm -f "$RF"

# The query string is split off the path for every route, not just this one.
# Before that, a single `?` made /api/status a 404.
check "a query string does not break another route" 200 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema?cachebust=1")"

echo "== a malformed schema must fail closed"
# confd prefers /etc/config/confd/keys.tsv, which is edited live on the device
# and which `make check` never sees. A row there that is short, or whose type is
# misspelt, used to be the MOST permissive row in the file: the out-params were
# left empty, and empty was neither "never" nor a known type, so the key became
# writable and unvalidated.
mkdir -p /etc/config/confd
{
	printf 'name\tstore\taddress\tsection\ttype\tapply\twritable\tcommon\n'
	printf 'SHORT_ROW\tcs\tSHORT_ROW\tTest\tint\tunknown\n'
	printf 'BAD_TYPE\tcs\tBAD_TYPE\tTest\titn\tunknown\tyes\tno\n'
	printf 'GOOD_ROW\tcs\tGOOD_ROW\tTest\tint\tunknown\tyes\tno\n'
} > /etc/config/confd/keys.tsv

check "a row missing its columns is not writable" yes \
	"$(err "$(post 'SHORT_ROW=1')" 'not in the schema')"
check "a misspelt type is refused, not waved through" yes \
	"$(err "$(post 'BAD_TYPE=anything')" 'not valid for its type')"
check "a well-formed row in the same file still works" yes \
	"$(err "$(post 'GOOD_ROW=7')" '"ok":true,"value":"7"')"
rm -f /etc/config/confd/keys.tsv

echo "== the stick clock and the ntpd status file"
# GET /api/ntp answers the wall clock and the five fields ntpd leaves in
# /tmp/ntp-status. The file is the image's, so only known keys and plain
# numbers go out; anything else is blanked, and an unknown event is null.
ntpj() { curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/ntp"; }
rm -f /tmp/ntp-status
check "no status file: the clock and a null status" yes \
	"$(err "$(ntpj)" ',"ntp":null}')"
check "the clock is a plausible epoch" yes \
	"$(err "$(ntpj)" '{"now":1')"
printf 'event=step\ntime=1760773900\noffset=-0.004\nstratum=2\nlast_sync=1760773900\n' > /tmp/ntp-status
check "a status file is passed on, field by field" yes \
	"$(err "$(ntpj)" '"ntp":{"event":"step","time":"1760773900","offset":"-0.004","stratum":"2","last_sync":"1760773900"}}')"
printf 'event=unsync\ntime=1760773900\noffset=\nstratum=16\nlast_sync=\nextra=<script>\n' > /tmp/ntp-status
check "empty values stay empty, unknown keys are dropped" yes \
	"$(err "$(ntpj)" '"offset":"","stratum":"16","last_sync":""}}')"
printf 'event=periodic\ntime=17\"x\noffset=1e5<b>\nstratum=2\nlast_sync=5\n' > /tmp/ntp-status
check "a value with other characters is blanked, never echoed" yes \
	"$(err "$(ntpj)" '"time":"","offset":"","stratum":"2","last_sync":"5"}}')"
printf 'event=<b>hi</b>\ntime=1\n' > /tmp/ntp-status
check "an unknown event is not a status" yes \
	"$(err "$(ntpj)" ',"ntp":null}')"
rm -f /tmp/ntp-status

echo "== the chip temperature sensor"
# /api/status adds chip_temp from the hwmon device named rtl9602c_soc, by plain
# file reads: members only for files that exist, nothing at all without the
# device, and a value only if it is a plain integer, printed again.
chip() { curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/status" | grep -o '"chip_temp":{[^}]*}' || echo none; }
chipdev() { rm -rf "$HWMON"; mkdir -p "$HWMON/hwmon0" "$HWMON/hwmon3"; echo coretemp > "$HWMON/hwmon0/name"; echo rtl9602c_soc > "$HWMON/hwmon3/name"; }
check "no hwmon directory: no chip_temp" none "$(chip)"
chipdev
check "no temp1_input: no chip_temp" none "$(chip)"
echo 71250 > "$HWMON/hwmon3/temp1_input"
check "without limits, the temperature alone" '"chip_temp":{"celsius":71.3}' "$(chip)"
echo 95000 > "$HWMON/hwmon3/temp1_max"; echo 110000 > "$HWMON/hwmon3/temp1_crit"
echo 0 > "$HWMON/hwmon3/temp1_max_alarm"; echo 0 > "$HWMON/hwmon3/temp1_crit_alarm"
check "normal, found by its name past another device" \
	'"chip_temp":{"celsius":71.3,"max":95.0,"crit":110.0,"max_alarm":false,"crit_alarm":false}' "$(chip)"
echo 96400 > "$HWMON/hwmon3/temp1_input"; echo 1 > "$HWMON/hwmon3/temp1_max_alarm"
check "the warning alarm" \
	'"chip_temp":{"celsius":96.4,"max":95.0,"crit":110.0,"max_alarm":true,"crit_alarm":false}' "$(chip)"
echo 112000 > "$HWMON/hwmon3/temp1_input"; echo 1 > "$HWMON/hwmon3/temp1_crit_alarm"
check "the critical alarm" \
	'"chip_temp":{"celsius":112.0,"max":95.0,"crit":110.0,"max_alarm":true,"crit_alarm":true}' "$(chip)"
echo -5050 > "$HWMON/hwmon3/temp1_input"; echo 'x<b>' > "$HWMON/hwmon3/temp1_max"; echo 2 > "$HWMON/hwmon3/temp1_crit_alarm"
check "a negative reading; a limit that is not a number or a flag that is not 0 or 1 is left out" \
	'"chip_temp":{"celsius":-5.1,"crit":110.0,"max_alarm":true}' "$(chip)"
echo rtl9602c_soc_x > "$HWMON/hwmon3/name"
check "a device whose name only starts the same is not it" none "$(chip)"
rm -rf "$HWMON"

echo "== the host link and the safe mode: state, banner data, verbs, credential"
# odi-oss keeps the state of this boot in /var/run/host-autoneg (key=value,
# replaced by a rename), the flag of a safe-mode boot in /var/run/safe-mode
# and the safe-mode record in /etc/config/safe-mode until it is
# acknowledged; the page reads them through GET /api/hostlink, with no fork,
# and raises the banner from them. host-autoneg.sh runs try, confirm and
# revert, safe-mode.sh runs ack; the stubs echo them, and the ack one removes
# the record as the real one does.
hl() { curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/hostlink"; }
hlpost() { curl -s -u "$AUTH" -X POST --data "$1" "http://127.0.0.1:$PORT/api/hostlink"; }
rm -f /etc/scripts/host-autoneg.sh /etc/scripts/safe-mode.sh /var/run/host-autoneg /var/run/safe-mode /etc/config/safe-mode
mkdir -p /var/run
check "without the scripts: not supported, no state, no safe mode" yes \
	"$(err "$(hl)" '"supported":false,"state":{},"serdes":{"supported":false,"state":{}},"safemode_now":null,"safemode":null')"
check "without the script: a verb is refused" yes \
	"$(err "$(hlpost 'action=confirm')" 'this image has no /etc/scripts/host-autoneg.sh')"
check "without safe-mode.sh: ack is refused" yes \
	"$(err "$(hlpost 'action=ack')" 'this image has no /etc/scripts/safe-mode.sh')"
cat > /etc/scripts/host-autoneg.sh <<'HOSTLINK'
#!/bin/sh
echo "host-autoneg.sh: $*"
[ "$1" = confirm ] && [ -f /tmp/hostlink-refuse ] && { echo "host-autoneg: no trial is running" >&2; exit 1; }
exit 0
HOSTLINK
cat > /etc/scripts/safe-mode.sh <<'SAFEMODE'
#!/bin/sh
echo "safe-mode.sh: $*"
[ "$1" = ack ] && rm -f /etc/config/safe-mode
exit 0
SAFEMODE
chmod +x /etc/scripts/host-autoneg.sh /etc/scripts/safe-mode.sh
printf '%s\n' setting=off running=on phase=steady fallback=1 'event=fallback' \
	'message=no host link with auto-negotiation off; "quoted" \ back' > /var/run/host-autoneg
printf '%s\n' short_boots=3 uptime=21 cleared=HOST_AUTONEG build=v1.5.0 > /etc/config/safe-mode
r=$(hl)
check "a quote and a backslash in the state are escaped" yes "$(err "$r" '; \"quoted\" \\ back"}')"
check "the boot fallback reaches the page" yes \
	"$(err "$r" '"state":{"setting":"off","running":"on","phase":"steady","fallback":"1"')"
check "not a safe-mode boot" yes "$(err "$r" '"safemode_now":null')"
check "the safe-mode record reaches the page" yes \
	"$(err "$r" '"safemode":{"short_boots":"3","uptime":"21","cleared":"HOST_AUTONEG","build":"v1.5.0"}')"
check "the uptime is whole seconds" yes "$(err "$r" '"uptime":"')"
check "try off runs host-autoneg.sh try off" yes \
	"$(err "$(hlpost 'action=try&mode=off')" '"ok":true,"output":"host-autoneg.sh: try off')"
check "try on runs host-autoneg.sh try on" yes \
	"$(err "$(hlpost 'action=try&mode=on')" 'host-autoneg.sh: try on')"
check "try with another mode is refused" 400 \
	"$(code -u "$AUTH" -X POST --data 'action=try&mode=sideways' "http://127.0.0.1:$PORT/api/hostlink")"
check "an unknown verb is refused, not passed on" 400 \
	"$(code -u "$AUTH" -X POST --data 'action=boot' "http://127.0.0.1:$PORT/api/hostlink")"
check "confirm runs host-autoneg.sh confirm" yes \
	"$(err "$(hlpost 'action=confirm')" 'host-autoneg.sh: confirm')"
: > /tmp/hostlink-refuse
r=$(hlpost 'action=confirm')
check "a refused confirm is reported as not ok" yes "$(err "$r" '"ok":false')"
check "  ... with the reason the script gave" yes "$(err "$r" 'no trial is running')"
rm -f /tmp/hostlink-refuse
check "revert runs host-autoneg.sh revert" yes \
	"$(err "$(hlpost 'action=revert')" 'host-autoneg.sh: revert')"
check "a cross-site verb is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST --data 'action=ack' "http://127.0.0.1:$PORT/api/hostlink")"
check "the record is still there after the refused one" yes "$(err "$(hl)" '"safemode":{"short_boots"')"
check "ack runs safe-mode.sh ack" yes "$(err "$(hlpost 'action=ack')" 'safe-mode.sh: ack')"
check "after the acknowledgement the page sees no record" yes "$(err "$(hl)" '"safemode":null')"
printf '%s\n' setting=off running=off phase=steady fallback=0 > /var/run/host-autoneg
check "the next boot with the forced link up: no fallback for the banner" yes \
	"$(err "$(hl)" '"fallback":"0"')"

# A safe-mode boot: the web UI accepts the built-in default credential, in
# memory, whatever confd.auth holds; the file is not touched, and the
# saved credential is back as soon as the flag is gone (the next boot).
printf '%s\n' short_boots=5 cleared=none root_password=default > /var/run/safe-mode
check "safe-mode boot: the flag reaches the page" yes \
	"$(err "$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/hostlink")" '"safemode_now":{"short_boots":"5","cleared":"none","root_password":"default"}')"
check "safe-mode boot: admin:admin is accepted" 200 \
	"$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"
check "safe-mode boot: the saved credential is not" 401 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"
check "safe-mode boot: the page is told the default is in force" yes \
	"$(err "$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/firmware")" '"defaultauth":true')"
check "safe-mode boot: confd.auth is untouched" "$AUTH" "$(cat /etc/config/confd.auth)"
rm -f /var/run/safe-mode
check "the next boot: the saved credential again" 200 "$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"
check "  and admin:admin no longer" 401 "$(code -u admin:admin "http://127.0.0.1:$PORT/api/schema")"
check "the Host port page is served" 200 "$(code -u "$AUTH" "http://127.0.0.1:$PORT/hostlink.js")"
rm -f /etc/scripts/host-autoneg.sh /etc/scripts/safe-mode.sh /var/run/host-autoneg

# The SerDes mode of the same port (HOST_SERDES, host-serdes.sh): its state in
# /var/run/host-serdes rides on GET /api/hostlink, and four fixed verbs run
# the script (serdes-try with a validated mode, serdes-confirm, serdes-revert,
# serdes-status, which answers the key=value lines as `status`). The stub
# echoes what it was given. safe-mode.sh now clears a list: `cleared=` can be
# HOST_AUTONEG, HOST_SERDES, both with a comma, none or failed.
rm -f /etc/scripts/host-serdes.sh /var/run/host-serdes /etc/config/safe-mode
check "without host-serdes.sh: the SerDes block is not supported" yes \
	"$(err "$(hl)" '"serdes":{"supported":false,"state":{}}')"
for v in serdes-confirm serdes-revert serdes-status; do
	check "without the script: $v is refused" yes \
		"$(err "$(hlpost "action=$v")" 'this image has no /etc/scripts/host-serdes.sh')"
done
check "without the script: serdes-try is refused" yes \
	"$(err "$(hlpost 'action=serdes-try&mode=2500basex')" 'this image has no /etc/scripts/host-serdes.sh')"
cat > /etc/scripts/host-serdes.sh <<'SERDES'
#!/bin/sh
echo "host-serdes.sh: $*"
[ "$1" = confirm ] && [ -f /tmp/hostlink-refuse ] && { echo "host-serdes: no trial is running" >&2; exit 1; }
[ "$1" = status ] && printf '%s\n' setting=2500basex running=fiber1g phase=steady fallback=1 link=1 link_source=host_link 'message=no sync; "q" \ back'
exit 0
SERDES
chmod +x /etc/scripts/host-serdes.sh
printf '%s\n' setting=2500basex running=fiber1g phase=trial fallback=1 trial_mode=2500basex trial_deadline=420 \
	'event=fallback' 'message=no sync in 2500BASE-X; "quoted" \ back' > /var/run/host-serdes
r=$(hl)
check "the SerDes block is supported" yes "$(err "$r" '"serdes":{"supported":true,"state":{"setting":"2500basex","running":"fiber1g","phase":"trial","fallback":"1","trial_mode":"2500basex","trial_deadline":"420"')"
check "a quote and a backslash in the SerDes state are escaped" yes "$(err "$r" '; \"quoted\" \\ back"}}')"
check "the autoneg state is not mixed into it" yes "$(err "$r" '"serdes":{"supported":true,"state":{"setting":"2500basex"')"
for m in fiber1g 2500basex hisgmii; do
	check "serdes-try $m runs host-serdes.sh try $m" yes \
		"$(err "$(hlpost "action=serdes-try&mode=$m")" "\"ok\":true,\"output\":\"host-serdes.sh: try $m")"
done
check "serdes-try with another mode is refused" 400 \
	"$(code -u "$AUTH" -X POST --data 'action=serdes-try&mode=sideways' "http://127.0.0.1:$PORT/api/hostlink")"
check "serdes-try with an autoneg mode is refused" 400 \
	"$(code -u "$AUTH" -X POST --data 'action=serdes-try&mode=off' "http://127.0.0.1:$PORT/api/hostlink")"
check "serdes-try with no mode is refused" 400 \
	"$(code -u "$AUTH" -X POST --data 'action=serdes-try' "http://127.0.0.1:$PORT/api/hostlink")"
check "a mode with a shell word is refused, not passed on" 400 \
	"$(code -u "$AUTH" -X POST --data-urlencode 'action=serdes-try' --data-urlencode 'mode=hisgmii;id' "http://127.0.0.1:$PORT/api/hostlink")"
check "a verb the script has but the page does not is refused" 400 \
	"$(code -u "$AUTH" -X POST --data 'action=serdes-reapply' "http://127.0.0.1:$PORT/api/hostlink")"
check "serdes-confirm runs host-serdes.sh confirm" yes \
	"$(err "$(hlpost 'action=serdes-confirm')" 'host-serdes.sh: confirm')"
: > /tmp/hostlink-refuse
r=$(hlpost 'action=serdes-confirm')
check "a refused SerDes confirm is reported as not ok" yes "$(err "$r" '"ok":false')"
check "  ... with the reason the script gave" yes "$(err "$r" 'no trial is running')"
rm -f /tmp/hostlink-refuse
check "serdes-revert runs host-serdes.sh revert" yes \
	"$(err "$(hlpost 'action=serdes-revert')" 'host-serdes.sh: revert')"
r=$(hlpost 'action=serdes-status')
check "serdes-status answers the script lines as members" yes \
	"$(err "$r" '"status":{"setting":"2500basex","running":"fiber1g","phase":"steady","fallback":"1","link":"1","link_source":"host_link","message":"no sync; \"q\" \\ back"}')"
check "a cross-site SerDes verb is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST --data 'action=serdes-revert' "http://127.0.0.1:$PORT/api/hostlink")"
check "the autoneg verbs still go to host-autoneg.sh" yes \
	"$(err "$(hlpost 'action=confirm')" 'this image has no /etc/scripts/host-autoneg.sh')"
for c in HOST_SERDES HOST_AUTONEG,HOST_SERDES failed none; do
	printf '%s\n' short_boots=3 uptime=21 "cleared=$c" build=v1.13.0 > /etc/config/safe-mode
	check "safe mode: cleared=$c reaches the page whole" yes "$(err "$(hl)" "\"cleared\":\"$c\"")"
done
rm -f /etc/scripts/host-serdes.sh /var/run/host-serdes /etc/config/safe-mode

echo "== the management address trial: state, verbs, the store refused the keys"
# odi-oss mgmt-addr.sh applies a change of the five address keys as a trial and
# stores them only when its confirm arrives over a new address. The page reads
# its state through GET /api/netaddr, with no fork, together with the address
# the request came in on and the client; confirm is passed THOSE, from the
# socket. POST /api/config refuses the five keys while the script exists and
# this is not a safe-mode boot. The stub echoes its arguments.
na() { curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/netaddr"; }
napost() { curl -s -u "$AUTH" -X POST --data "$1" "http://127.0.0.1:$PORT/api/netaddr"; }
rm -f /etc/scripts/mgmt-addr.sh /var/run/mgmt-addr /var/run/safe-mode /etc/config/getfake
check "without the script: not supported, no state" yes \
	"$(err "$(na)" '"supported":false,"state":{},"via":"127.0.0.1"')"
check "without the script: try is refused" yes \
	"$(err "$(napost 'action=try&LAN_IP_ADDR=10.1.1.1')" 'this image has no /etc/scripts/mgmt-addr.sh')"
check "without the script: the address key is stored as before" yes \
	"$(err "$(pt LAN_IP_ADDR 10.20.30.1)" '"ok":true,"value":"10.20.30.1"')"
cat > /etc/scripts/mgmt-addr.sh <<'NETADDR'
#!/bin/sh
echo "mgmt-addr.sh: $*"
[ "$1" = confirm ] && [ -f /tmp/netaddr-refuse ] && { echo "mgmt-addr: not confirmed: it arrived on an old address" >&2; exit 1; }
exit 0
NETADDR
chmod +x /etc/scripts/mgmt-addr.sh
printf '%s\n' phase=trial applied=1 trial_deadline=420 prev_ip=192.168.0.1 new_LAN_IP_ADDR=10.1.1.1 \
	'message=trying for 90 s: "quoted" \ back' > /var/run/mgmt-addr
r=$(na)
check "with the script: supported" yes "$(err "$r" '"supported":true')"
check "the state reaches the page" yes \
	"$(err "$r" '"phase":"trial","applied":"1","trial_deadline":"420","prev_ip":"192.168.0.1","new_LAN_IP_ADDR":"10.1.1.1","message":"trying for 90 s: \"quoted\" \\ back"')"
check "the address the request came in on, from the socket" yes "$(err "$r" '"via":"127.0.0.1","peer":"127.0.0.1"')"
check "the stick clock is there for the countdown" yes "$(err "$r" '"uptime":"')"
check "try runs mgmt-addr.sh try with KEY=VALUE words" yes \
	"$(err "$(napost 'action=try&LAN_IP_ADDR=10.1.1.1&LAN_SUBNET=255.255.0.0')" '"ok":true,"output":"mgmt-addr.sh: try LAN_IP_ADDR=10.1.1.1 LAN_SUBNET=255.255.0.0')"
check "the second address keys go through too" yes \
	"$(err "$(napost 'action=try&LAN_ENABLE_IP2=1&LAN_IP_ADDR2=172.20.0.1')" 'try LAN_ENABLE_IP2=1 LAN_IP_ADDR2=172.20.0.1')"
check "a key that is not an address key is not passed" yes \
	"$(err "$(napost 'action=try&LAN_IP_ADDR=10.1.1.1&HOST_AUTONEG=off&LAN_SDS_MODE=4')" 'try LAN_IP_ADDR=10.1.1.1\u000a"')"
check "try with no address key is refused" yes \
	"$(err "$(napost 'action=try&HOST_AUTONEG=off')" 'no management address key to try')"
check "try with an unusable address is refused, nothing run" yes \
	"$(err "$(napost 'action=try&LAN_IP_ADDR=1.2.3.999')" 'not valid for its type')"
check "try with an address that is not digits and dots is refused" yes \
	"$(err "$(napost 'action=try&LAN_IP_ADDR=1.2.3.4;reboot')" 'digits and dots')"
check "try with an empty value is refused" yes \
	"$(err "$(napost 'action=try&LAN_IP_ADDR2=')" 'cannot be empty')"
check "try with an unusable netmask is refused" yes \
	"$(err "$(napost 'action=try&LAN_SUBNET=255.0.255.0')" 'not valid for its type')"
check "try with the broadcast address of its mask is refused, as /api/config does" yes \
	"$(err "$(napost 'action=try&LAN_IP_ADDR=192.168.1.255&LAN_SUBNET=255.255.255.0')" 'network or broadcast address')"
check "try with a second address equal to the first is refused" yes \
	"$(err "$(napost 'action=try&LAN_IP_ADDR=10.1.1.1&LAN_ENABLE_IP2=1&LAN_IP_ADDR2=10.1.1.1')" 'the same as the other management address')"
check "LAN_ENABLE_IP2 is 0 or 1" yes "$(err "$(napost 'action=try&LAN_ENABLE_IP2=2')" 'LAN_ENABLE_IP2 is 0 or 1')"
# The static routes ride the same trial: one argv word with its spaces and
# commas, judged by the same grammar as /api/config.
R1='default%20via%20192.168.1.254'
check "try passes LAN_ROUTES as one KEY=VALUE word, spaces and all" yes \
	"$(err "$(napost "action=try&LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ROUTES=$R1")" 'try LAN_IP_ADDR=192.168.1.1 LAN_SUBNET=255.255.255.0 LAN_ROUTES=default via 192.168.1.254\u000a')"
check "commas inside the routes reach the script whole" yes \
	"$(err "$(napost "action=try&LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ROUTES=10.0.0.0/8%20via%20192.168.1.3,172.16.0.0/12%20via%20192.168.1.2")" 'LAN_ROUTES=10.0.0.0/8 via 192.168.1.3,172.16.0.0/12 via 192.168.1.2')"
check "an empty LAN_ROUTES is tried: it is how the routes are turned off" yes \
	"$(err "$(napost 'action=try&LAN_ROUTES=')" '"ok":true,"output":"mgmt-addr.sh: try LAN_ROUTES=\u000a')"
check "all six keys fit one try" yes \
	"$(err "$(napost "action=try&LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ENABLE_IP2=1&LAN_IP_ADDR2=172.20.0.1&LAN_SUBNET2=255.255.0.0&LAN_ROUTES=default%20via%20172.20.0.9")" 'LAN_SUBNET2=255.255.0.0 LAN_ROUTES=default via 172.20.0.9')"
check "a route through a gateway outside the management subnets is refused, nothing run" yes \
	"$(err "$(napost "action=try&LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ROUTES=default%20via%208.8.8.8")" 'outside the management subnets')"
check "the second subnet is not a gateway subnet while the second address is off" yes \
	"$(err "$(napost "action=try&LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ENABLE_IP2=0&LAN_IP_ADDR2=172.20.0.1&LAN_ROUTES=default%20via%20172.20.0.9")" 'outside the management subnets')"
check "a gateway that is the stick own address is refused" yes \
	"$(err "$(napost "action=try&LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ROUTES=default%20via%20192.168.1.1")" 'address of the stick itself')"
check "a gateway that is the broadcast address is refused" yes \
	"$(err "$(napost "action=try&LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ROUTES=default%20via%20192.168.1.255")" 'network or broadcast address')"
check "malformed routes are refused" yes \
	"$(err "$(napost 'action=try&LAN_ROUTES=10.0.0.1/8%20via%20192.168.1.3')" 'not valid for its type')"
check "routes with shell metacharacters are refused before the type" yes \
	"$(err "$(napost 'action=try&LAN_ROUTES=default%20via%201.2.3.4;reboot')" 'routes use digits, dots, slashes')"
check "routes with a quote or a newline are refused" yes \
	"$(err "$(napost 'action=try&LAN_ROUTES=default%20via%201.2.3.4%0Areboot')" 'routes use digits, dots, slashes')"
check "/api/config refuses LAN_ROUTES while the trial exists" yes \
	"$(err "$(post "LAN_ROUTES=$R1")" 'through the address trial')"
check "confirm passes the address and the client of this connection" yes \
	"$(err "$(napost 'action=confirm')" '"ok":true,"output":"mgmt-addr.sh: confirm 127.0.0.1 127.0.0.1')"
check "a confirm cannot name its own address in the request" yes \
	"$(err "$(napost 'action=confirm&via=10.1.1.1&LAN_IP_ADDR=10.1.1.1')" 'confirm 127.0.0.1 127.0.0.1\u000a"')"
: > /tmp/netaddr-refuse
r=$(napost 'action=confirm')
check "a refused confirm says so, ok false" yes "$(err "$r" '"ok":false')"
check "and why" yes "$(err "$r" 'it arrived on an old address')"
rm -f /tmp/netaddr-refuse
check "revert runs mgmt-addr.sh revert" yes "$(err "$(napost 'action=revert')" 'mgmt-addr.sh: revert')"
check "an unknown action is refused" 400 \
	"$(code -u "$AUTH" -X POST --data 'action=boot' "http://127.0.0.1:$PORT/api/netaddr")"
check "a cross-site POST is refused" 403 \
	"$(code -u "$AUTH" -H 'Origin: http://evil.example' -X POST --data 'action=revert' "http://127.0.0.1:$PORT/api/netaddr")"
check "the state is readable without a fork on every poll" yes "$(err "$(na)" '"supported":true')"
# The store: while the script exists the five keys are refused by /api/config.
for k in LAN_IP_ADDR=10.20.30.1 LAN_SUBNET=255.255.255.0 LAN_ENABLE_IP2=1 LAN_IP_ADDR2=172.20.0.1 LAN_SUBNET2=255.255.255.0; do
	check "/api/config refuses ${k%%=*} while the trial exists" yes \
		"$(err "$(post "$k")" 'through the address trial')"
done
check "  ... and says so in the apply class too: no network action" yes \
	"$(err "$(post 'LAN_IP_ADDR=10.20.30.1')" '"needs":[]')"
check "another key is written as always" yes "$(err "$(post 'VLAN_MANU_TAG_VID=100')" '"name":"VLAN_MANU_TAG_VID","ok":true')"
# A safe-mode boot stores them directly: the rescue address is the way in.
printf '%s\n' short_boots=5 > /var/run/safe-mode
check "safe-mode boot: the trial is not offered" yes \
	"$(err "$(curl -s -u admin:admin "http://127.0.0.1:$PORT/api/netaddr")" '"supported":false')"
check "safe-mode boot: /api/config stores the address" yes \
	"$(err "$(curl -s -u admin:admin -X POST --data-urlencode LAN_IP_ADDR=10.20.30.1 "http://127.0.0.1:$PORT/api/config")" '"ok":true,"value":"10.20.30.1"')"
check "safe-mode boot: /api/config stores LAN_ROUTES, judged against the same request" yes \
	"$(err "$(curl -s -u admin:admin -X POST --data "LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ROUTES=$R1" "http://127.0.0.1:$PORT/api/config")" '"name":"LAN_ROUTES","ok":true,"value":"default via 192.168.1.254"')"
check "safe-mode boot: a gateway outside the subnet is refused there too" yes \
	"$(err "$(curl -s -u admin:admin -X POST --data "LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ROUTES=default%20via%208.8.8.8" "http://127.0.0.1:$PORT/api/config")" 'outside the management subnets')"
check "safe-mode boot: an empty LAN_ROUTES clears the key" yes \
	"$(err "$(curl -s -u admin:admin -X POST --data 'LAN_ROUTES=' "http://127.0.0.1:$PORT/api/config")" '"name":"LAN_ROUTES","ok":true')"
check "safe-mode boot: LAN_ROUTES asks for the network action" yes \
	"$(err "$(curl -s -u admin:admin -X POST --data "LAN_ROUTES=$R1" "http://127.0.0.1:$PORT/api/config")" '"needs":["network"]')"
rm -f /var/run/safe-mode
check "the netaddr page module is served" 200 "$(code -u "$AUTH" "http://127.0.0.1:$PORT/netaddr.js")"
check "the static routes editor module is served" 200 "$(code -u "$AUTH" "http://127.0.0.1:$PORT/lanroutes.js")"
rm -f /etc/scripts/mgmt-addr.sh /var/run/mgmt-addr

echo "== request deadlines, and a body that is not what it declared"
U="http://127.0.0.1:$PORT"

# SO_RCVTIMEO bounds one read(), so a client sending a byte every second never
# tripped it and held the single thread for hours. The request has a deadline
# of its own (REQUEST_DEADLINE_MS, 10 s): the connection is closed on it even
# though bytes keep arriving. The probe sends one byte a second and reports
# whether the server hung up within 15 s.
slow=$(python3 - "$PORT" <<'PY'
import socket, sys, time
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5)
t0 = time.time()
req = b"GET /api/schema HTTP/1.0\r\nX-Pad: " + b"a" * 200
closed = None
for b in req:
    try:
        s.sendall(bytes([b]))
        s.settimeout(0.05)
        try:
            if s.recv(1) == b"":
                closed = time.time() - t0
                break
        except socket.timeout:
            pass
    except OSError:
        closed = time.time() - t0
        break
    time.sleep(1.0)
    if time.time() - t0 > 25:
        break
print("closed" if closed is not None and closed < 15 else "open")
PY
)
check "a client that dribbles bytes is cut off by the request deadline" closed "$slow"
check "and the server answers right after" 200 "$(code -u "$AUTH" "$U/api/schema")"

# More body than declared: `left = want - have` wrapped to four billion and the
# loop wrote whatever came next into /tmp until it was full. The extra bytes
# are not part of the body now. Ten declared, four thousand sent in one segment.
over=$(python3 - "$PORT" "$AUTH" /tmp/small.tar <<'PY'
import base64, socket, sys
port, auth = int(sys.argv[1]), sys.argv[2]
img = open(sys.argv[3], "rb").read()
cred = base64.b64encode(auth.encode()).decode()
s = socket.create_connection(("127.0.0.1", port), timeout=10)
s.sendall(b"POST /api/upload HTTP/1.0\r\nAuthorization: Basic " + cred.encode() +
          b"\r\nContent-Length: " + str(len(img)).encode() + b"\r\n\r\n" + img + b"A" * 4000)
out = b""
while True:
    d = s.recv(4096)
    if not d:
        break
    out += d
print(out.decode("utf-8", "replace").split("\r\n\r\n", 1)[-1])
PY
)
check "bytes past the declared length are not part of the upload" yes "$(err "$over" "\"ok\":true,\"bytes\":$SMALL_BYTES")"
check "and the file is exactly the declared length" "$SMALL_BYTES" "$(wc -c < /tmp/img.tar | tr -d ' ')"

# A write in progress reads that file. The state file is the script's own
# (fwu_starter.sh): running, a live pid.
sleep 300 &
LIVE=$!
printf 'running %s 1\n' "$LIVE" > /tmp/fwu.state
check "an upload is refused while a firmware write is running" 409 \
	"$(code -u "$AUTH" -X POST --data-binary 'x' "$U/api/upload")"
check "and the image it was reading is untouched" "$SMALL_BYTES" "$(wc -c < /tmp/img.tar | tr -d ' ')"
# The same state refuses a reboot: nothing is rebooted under a running write.
r=$(curl -s -u "$AUTH" -X POST -d 'action=reboot&partition=' "$U/api/firmware")
check "a reboot is refused while a firmware write is running" 409 \
	"$(code -u "$AUTH" -X POST -d 'action=reboot&partition=' "$U/api/firmware")"
check "and says why" yes "$(err "$r" '"ok":false,"error":"a firmware write is running; rebooting now')"
kill "$LIVE" 2>/dev/null || true
wait "$LIVE" 2>/dev/null || true
check "a state naming a dead process does not block an upload" 200 \
	"$(code -u "$AUTH" -X POST --data-binary @/tmp/small.tar "$U/api/upload")"
rm -f /tmp/fwu.state

# The upload name is made fresh, not opened through whatever is there.
echo keep > /tmp/target.keep
rm -f /tmp/img.tar
ln -s /tmp/target.keep /tmp/img.tar
check "an upload through a planted link still succeeds" 200 \
	"$(code -u "$AUTH" -X POST --data-binary @/tmp/small.tar "$U/api/upload")"
check "but does not write through the link" keep "$(cat /tmp/target.keep)"
check "and the image is a regular file" yes "$([ -f /tmp/img.tar ] && [ ! -L /tmp/img.tar ] && echo yes || echo no)"
rm -f /tmp/target.keep /tmp/img.tar

# A field that does not fit its buffer is an error, not a prefix: cut at the
# buffer (1279 bytes, VALUE_MAX) it was validated, written and read back against itself, and reported
# saved.
long=$(python3 -c 'print("x" * 1400)')
r=$(post "SNMP_SYS_NAME=$long")
check "a value too long for its buffer is refused" yes "$(err "$r" 'too long')"
check "and is not reported as saved" no "$(err "$r" '"ok":true' | grep -q '^yes' && echo yes || echo no)"
mid=$(python3 -c 'print("y" * 40)')
r=$(post "SNMP_SYS_NAME=$mid&GPON_SN=ODI012345678&_confirm=identity")
check "a long value before _confirm does not hide the confirmation" yes \
	"$(err "$r" '"name":"GPON_SN","ok":true')"
check "a value too long for form_get is not truncated into a match" 400 \
	"$(code -u "$AUTH" -X POST --data 'action=writeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&partition=1' "$U/api/firmware")"
echo "== a child that outlives its output must not hold the daemon"
U="http://127.0.0.1:$PORT"
cp /bin/omcicli /tmp/omcicli.kept
# Prints more than the 32 KB answer buffer, then waits on something that never
# comes: the drain used to stop at "full" and block in waitpid() for the sleep.
cat > /bin/omcicli <<'STUB'
#!/bin/sh
head -c 40000 /dev/zero | tr '\0' x
sleep 30
STUB
t0=$(date +%s)
r=$(curl -s --max-time 25 -u "$AUTH" "$U/api/omci?cmd=me&me=84")
t1=$(date +%s)
check "a child that fills the buffer and then hangs is cut off in a few seconds" yes \
	"$([ $((t1 - t0)) -lt 10 ] && echo yes || echo "no: $((t1 - t0)) s")"
check "and the answer says it timed out, with what fit" yes "$(err "$r" 'timed out')"
# Closes its output and then does not exit: EOF, then a blocking waitpid().
cat > /bin/omcicli <<'STUB'
#!/bin/sh
echo started
exec >&- 2>&-
sleep 30
STUB
t0=$(date +%s)
r=$(curl -s --max-time 25 -u "$AUTH" "$U/api/omci?cmd=me&me=84")
t1=$(date +%s)
check "a child that closes its output and hangs is cut off in a few seconds" yes \
	"$([ $((t1 - t0)) -lt 10 ] && echo yes || echo "no: $((t1 - t0)) s")"
check "and the server answers right after" 200 "$(code -u "$AUTH" "$U/api/schema")"
# SIGPIPE is the default again in a child (the daemon ignores it itself).
cat > /bin/omcicli <<'STUB'
#!/bin/sh
grep SigIgn /proc/self/status
STUB
r=$(curl -s -u "$AUTH" "$U/api/omci?cmd=me&me=84")
sigign=$(printf '%s' "$r" | sed -n 's/.*SigIgn:\\u0009\([0-9a-f]*\).*/\1/p')
check "the child reported its signal mask" yes "$([ -n "$sigign" ] && echo yes || echo "no: $r")"
check "a child does not inherit an ignored SIGPIPE" 0 \
	"$(( 0x${sigign:-1} & 0x1000 ))"
cp /tmp/omcicli.kept /bin/omcicli
rm -f /tmp/omcicli.kept

echo "== validation vectors"
# scripts/fixtures/validation-vectors.tsv is the table of what every input
# accepts and refuses; scripts/web-check.mjs runs the same rows through the
# page. A row is posted to the route that owns the input, and what comes back
# must be the table's word: ok accepted, bad refused.
VEC=scripts/fixtures/validation-vectors.tsv
# The gateway of a LAN_ROUTES row is judged against the stored management
# addresses, which the checks above left changed: put the stock ones back.
curl -s -u "$AUTH" -X POST --data 'LAN_IP_ADDR=192.168.1.1&LAN_SUBNET=255.255.255.0&LAN_ENABLE_IP2=0' \
	"http://127.0.0.1:$PORT/api/config" > /dev/null
cp /etc/config/confd.auth /etc/config/confd.auth.vec
rm -f /etc/config/dropbear.d/authorized_keys
vec_n=0
vec_bad=0
# Tabs become a separator that is not whitespace, or read would fold the empty
# fields (a row with no name, or no value) into their neighbours.
while IFS=$'\037' read -r kind name value expect why; do
	case "$kind" in ''|'#'*|kind) continue ;; esac
	vec_n=$((vec_n + 1))
	got=bad
	case "$kind" in
	key)
		r=$(curl -s -u "$AUTH" -X POST --data "$name=$value&_confirm=identity" "http://127.0.0.1:$PORT/api/config")
		case "$r" in *'"ok":true'*) got=ok ;; esac ;;
	password)
		c=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST --data "user=$name&password=$value" "http://127.0.0.1:$PORT/api/password")
		[ "$c" = 200 ] && got=ok
		# put the credential back so the next row, and the checks after, still sign in
		cp /etc/config/confd.auth.vec /etc/config/confd.auth ;;
	sshkey)
		c=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST --data "key=$value" "http://127.0.0.1:$PORT/api/sshkeys")
		[ "$c" = 200 ] && got=ok ;;
	ping)
		c=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST --data "host=$value" "http://127.0.0.1:$PORT/api/ping")
		[ "$c" = 200 ] && got=ok ;;
	me)
		c=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=$value")
		[ "$c" = 200 ] && got=ok ;;
	entity)
		c=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" "http://127.0.0.1:$PORT/api/omci?cmd=me&me=84&entity=$value")
		[ "$c" = 200 ] && got=ok ;;
	esac
	if [ "$got" != "$expect" ]; then
		vec_bad=$((vec_bad + 1))
		check "vector $kind $name ${value:0:40} ($why)" "$expect" "$got"
	fi
done < <(tr '\t' '\037' < "$VEC")
mv /etc/config/confd.auth.vec /etc/config/confd.auth
rm -f /etc/config/dropbear.d/authorized_keys
check "$vec_n validation vectors agree with the daemon" 0 "$vec_bad"
check "the credential survived the password vectors" 200 \
	"$(code -u "$AUTH" "http://127.0.0.1:$PORT/api/schema")"

# What a vector cannot say: a refusal that depends on the request, or on bytes.
# The second management address while it is on must differ from the first.
check "the second address equal to the first, in one request, is refused" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'LAN_ENABLE_IP2=1&LAN_IP_ADDR=192.168.1.1&LAN_IP_ADDR2=192.168.1.1' "http://127.0.0.1:$PORT/api/config")" 'the same as the other management address')"
check "the second address on while it differs from the first is accepted" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'LAN_ENABLE_IP2=1&LAN_IP_ADDR=192.168.1.1&LAN_IP_ADDR2=192.168.100.1' "http://127.0.0.1:$PORT/api/config")" '"name":"LAN_IP_ADDR2","ok":true')"
check "equal while the second address is off is accepted" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'LAN_ENABLE_IP2=0&LAN_IP_ADDR2=192.168.1.1' "http://127.0.0.1:$PORT/api/config")" '"name":"LAN_IP_ADDR2","ok":true')"
check "slot 128 says why" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'OMCI_VEIP_SLOT_ID=128' "http://127.0.0.1:$PORT/api/config")" 'omcid ignores it')"
check "a NUL byte in a value is refused, not read as the text before it" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data 'GPON_SN=ODI012345678%00junk&_confirm=identity' "http://127.0.0.1:$PORT/api/config")" 'badly encoded')"
check "a value of five hundred characters in a string key says what is allowed" yes \
	"$(err "$(curl -s -u "$AUTH" -X POST --data "SNMP_SYS_NAME=$(printf 'a%.0s' $(seq 500))" "http://127.0.0.1:$PORT/api/config")" 'not valid for its type')"

# The upload must be a tar archive: a 512-byte header with ustar at offset 257.
head -c 4096 /dev/zero > /tmp/notatar.bin
check "an upload that is not a tar archive is refused" 400 \
	"$(code -u "$AUTH" -X POST --data-binary @/tmp/notatar.bin "http://127.0.0.1:$PORT/api/upload")"
check "and it is not kept" no "$([ -e /tmp/img.tar ] && echo yes || echo no)"
head -c 600 /dev/urandom > /tmp/notatar.bin
check "random bytes are not a tar archive either" 400 \
	"$(code -u "$AUTH" -X POST --data-binary @/tmp/notatar.bin "http://127.0.0.1:$PORT/api/upload")"
check "a tar archive is accepted" 200 \
	"$(code -u "$AUTH" -X POST --data-binary @/tmp/small.tar "http://127.0.0.1:$PORT/api/upload")"
rm -f /tmp/notatar.bin /tmp/img.tar

echo "== an idle client must not take the server down"
# Single-threaded and serial, so a peer that connects and never sends used to
# block every other request indefinitely -- a port scanner holding a socket, or
# a client whose network dropped between connect and send. SO_RCVTIMEO bounds
# it. This deliberately waits out that timeout, which is why it is the slowest
# check here.
python3 -c 'import socket,sys,time
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5)
time.sleep(30)' "$PORT" &
IDLE=$!
sleep 1
if curl -fsS --max-time 25 -u "$AUTH" -o /dev/null "http://127.0.0.1:$PORT/api/schema"; then
	r=served
else
	r=blocked
fi
kill $IDLE 2>/dev/null || true
check "the server recovers from a peer that never sends" served "$r"

echo
if [ "$fail" -gt 0 ]; then
	echo "$fail failed, $pass passed"
	exit 1
fi
echo "$pass checks passed"

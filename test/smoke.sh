#!/bin/zsh
# Quick checks on a throwaway server (never touches data/). Usage: zsh test/smoke.sh [port]
setopt no_nomatch
P=${1:-9501}
D=$(mktemp -d)
cd "${0:A:h}/.."
B=http://localhost:$P; SB=http://localhost:$((P+1))
J=(-H 'Content-Type: application/json'); ST=$D/st
pass=0; failn=0
check() { if [[ "$3" == "$2" ]]; then pass=$((pass+1)); printf "  ok    %-56s %s\n" "$1" "$3"; else failn=$((failn+1)); printf "  FAIL  %-56s expected %s got %s\n" "$1" "$2" "$3"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }
field() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)"; }
srv() { env PORT=$P STAFF_PORT=$((P+1)) TABLE_GPS=off UPI_ID=cafe-test@upi STAFF_PASSWORD=testpass123 DB=$D/orders.db "$@" node --disable-warning=ExperimentalWarning server.js > $D/log 2>&1 & SP=$!; sleep 1
  curl -s -c $ST -X POST $J -d '{"password":"testpass123"}' $SB/api/staff/login >/dev/null; }
online() { body -X POST $J -H "CF-Connecting-IP: 198.51.100.$1" -d "{\"kind\":\"pickup\",\"name\":\"Ravi\",\"phone\":\"98000000$1\",\"items\":[{\"id\":\"beverages-special-tea\",\"qty\":1}]}" $B/api/online-orders; }
TODAY=$(TZ=Asia/Kolkata date +%F); TOMORROW=$(TZ=Asia/Kolkata date -v+1d +%F 2>/dev/null || TZ=Asia/Kolkata date -d tomorrow +%F)

echo "Opening hours"
NOW=$(TZ=Asia/Kolkata date +%H)
srv ORDER_HOURS=00:00-00:01; check "after closing: 'Closed for today'"          after $(body $B/api/menu | field '["status"]["state"]'); kill $SP; sleep 0.3
srv ORDER_HOURS=23:58-23:59; check "before opening: 'Opening soon'"              before $(body $B/api/menu | field '["status"]["state"]')
check "orders refused with the same message"                                    closed $(online 10 | field '["error"]'); kill $SP; sleep 0.3

echo "Closed days"
srv ORDER_HOURS=always
check "staff only"                                                             401 $(code -X POST $J -d "{\"day\":\"$TODAY\"}" $SB/api/kitchen/closed-days -H 'Cookie: x=y')
check "not on the customer door"                                               404 $(code -X POST $J -d "{\"day\":\"$TODAY\"}" $B/api/kitchen/closed-days)
check "receptionist closes today (Diwali)"                                     holiday $(body -b $ST -X POST $J -d "{\"day\":\"$TODAY\",\"note\":\"Diwali\"}" $SB/api/kitchen/closed-days | field '["status"]["state"]')
body -b $ST -X POST $J -d "{\"day\":\"$TOMORROW\"}" $SB/api/kitchen/closed-days >/dev/null
check "customers told why and when it reopens (skips tomorrow)"                True "$(body $B/api/menu | field '["status"]["message"].startswith("The cafe is closed today for Diwali. We'"'"'ll be back on ")')"
check "online order refused"                                                   closed $(online 11 | field '["error"]')
check "a past date is refused"                                                 400 $(code -b $ST -X POST $J -d '{"day":"2020-01-01"}' $SB/api/kitchen/closed-days)
check "open today again"                                                       open $(body -b $ST -X POST $J -d "{\"day\":\"$TODAY\",\"remove\":true}" $SB/api/kitchen/closed-days | field '["status"]["state"]')

echo "Customer cancels their own order"
R=$(online 12); ID=$(echo $R | field '["id"]'); TK=$(echo $R | field '["token"]')
check "wrong token can't cancel"                                               404 $(code -X POST $J -d '{}' "$B/api/orders/$ID/cancel?t=nope")
check "customer cancels"                                                       "cancelled customer" "$(body -X POST $J -d '{}' "$B/api/orders/$ID/cancel?t=$TK" | field '["status"],d["cancelledBy"]')"
R=$(online 13); ID=$(echo $R | field '["id"]'); TK=$(echo $R | field '["token"]')
code -b $ST -X POST $SB/api/kitchen/orders/$ID/approve >/dev/null
code -b $ST -X PATCH $J -d '{"status":"preparing"}' $SB/api/kitchen/orders/$ID >/dev/null
check "too late once the kitchen started"                                      started $(body -X POST $J -d '{}' "$B/api/orders/$ID/cancel?t=$TK" | field '["error"]')

echo "Cash"
check "receptionist: paid in cash"                                             cash $(body -b $ST -X POST $J -d '{"result":"cash"}' $SB/api/kitchen/orders/$ID/payment | field '["paidMethod"]')
kill $SP
rm -rf "${D:?}"
echo "\n$pass passed, $failn failed"
[[ $failn == 0 ]]

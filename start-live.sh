#!/bin/zsh
# Go live from this Mac: free Cloudflare quick tunnel -> customer door (8080) only.
# The staff screen stays at http://localhost:8081 on this Mac.
cd "${0:A:h}"
mkdir -p data; LOG=data/tunnel.log; : > $LOG
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8080 > $LOG 2>&1 &
TP=$!; trap "kill $TP 2>/dev/null" EXIT INT TERM
for i in {1..60}; do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' $LOG | head -1); [[ -n $URL ]] && break; sleep 1
done
[[ -z $URL ]] && { echo "Tunnel didn't start, see $LOG"; exit 1; }
echo "$URL" > data/live-url.txt
echo "\nLIVE:  $URL/online.html   (table QR: $URL/order.html?table=N)\n"
# caffeinate keeps the Mac awake while this runs
PUBLIC_URL=$URL caffeinate -is node --env-file-if-exists=.env.local --disable-warning=ExperimentalWarning server.js

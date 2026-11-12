# Good Luck Cafe: website and table ordering

- `index.html`, `style.css`, `images/`: the public website (hosted on GitHub Pages).
- `server.js`, `order.*`, `online.html`, `kitchen.*`, `tables.*`, `app.css`, `menu.json`: table ordering and online ordering (delivery / pickup), which run **on the cafe's own computer**.

## How the ordering system is laid out

One program runs on the cafe computer. It has one database and two doors:

| Door | Address | Who uses it | Reachable from |
|---|---|---|---|
| Customer door | `http://localhost:8080` → published as `https://order.goodluckcafe.in` | Customers' phones: QR on the table (`/order.html`) and online orders from the website (`/online.html`) | The internet, **only through the tunnel** |
| Staff door | `http://localhost:8081` | Receptionist + kitchen screen, printing QR cards | **This computer only** |

Both doors share the same database, so when the receptionist taps *Approve* or *Mark ready*, the customer's phone updates within a few seconds.

The staff door is never published. The tunnel only points at port 8080, and the staff door only accepts connections from the computer it runs on.

## One-time setup

You need:
- **A computer that stays on while the cafe is open:** a laptop or a small PC at the counter.
- **Internet for that computer:** a phone hotspot or a 4G/5G dongle.
- **A domain name:** for example `goodluckcafe.in` (about ₹700–900 a year).
- **A free Cloudflare account,** with that domain added to it.

### 1. Install Node.js
Download the **LTS** version from nodejs.org (version 22.13 or newer) and install it.

### 2. Put this folder on the computer and set the staff password
Open a terminal in this folder and run:
```
npm run set-password -- "choose-a-strong-password"
```

### 3. Install Cloudflare Tunnel and connect the domain
Install `cloudflared` (see Cloudflare's "Install cloudflared" page for Windows or Mac), then run:
```
cloudflared tunnel login
cloudflared tunnel create goodluck
cloudflared tunnel route dns goodluck order.goodluckcafe.in
```
Create the file `config.yml` in cloudflared's folder (the `login` step prints where that folder is):
```
tunnel: goodluck
credentials-file: <the .json file that "tunnel create" printed>
ingress:
  - hostname: order.goodluckcafe.in
    service: http://localhost:8080     # customer door ONLY. Never 8081.
  - service: http_status:404
```
Install it so it starts by itself when the computer starts:
```
cloudflared service install
```

### 4. Start the ordering server
```
PUBLIC_URL=https://order.goodluckcafe.in npm start
```
On Windows (PowerShell):
```
$env:PUBLIC_URL="https://order.goodluckcafe.in"; npm start
```
It prints both door addresses when it's running.

### 5. Print the table QR cards
On the cafe computer, open `http://localhost:8081/tables.html`. The address on the cards should be `https://order.goodluckcafe.in`. Click **Print cards**.

## Every day

1. **Start of the day:** turn the computer on, make sure it's online, and start the server (step 4).
2. **Open the staff screen:** go to `http://localhost:8081` and log in.
3. **Guests sit down:** tap **Turn on** on their table. For the next 10 minutes, phones that scan that table's QR code join it.
4. **First order from a phone:** it shows under **Approve new phones**. Check someone is sitting at that table, then tap **Approve**.
5. **Late friend:** if they arrive after 10 minutes, tap **Let more phones join** on that table.
6. **Guests leave:** tap **Turn off**. It shows the bill, and their phones can no longer order.

## Online orders (delivery and pickup)

- **Where:** the website's **Order online** buttons open `online.html`.
- **Delivery area:** delivery is only for customers within **10 km** of the cafe. The customer taps "Use my location", and the server measures the distance itself.
- **Delivery charge:** free up to 3 km, ₹20 up to 6 km, ₹40 up to 10 km. Pickup is free and needs no location.
- **Payment:** cash or UPI on delivery, or at pickup.
- **Confirming:** every online order shows under **Needs your OK** with the customer's number, address and a map link. Call them to confirm, then tap **Confirmed on call** to send it to the kitchen, or **Reject** if it's fake.
- **Limits:** 3 orders per mobile number per hour, at most 2 waiting to be confirmed per number.
- **To change the 10 km area or the charges:** edit `DELIVERY` near the top of `server.js`. The cafe's map position is stored there too.

**Going live:** the website is hosted separately on GitHub Pages, so change its two **Order online** links in `index.html` (they have `data-order-link`) from `online.html` to the full address, for example `https://order.goodluckcafe.in/online.html`.

## Settings (optional)

| Setting | Default | Meaning |
|---|---|---|
| `TABLES` | 12 | Number of tables |
| `JOIN_MINUTES` | 10 | How long phones can join after a table is turned on |
| `SESSION_HOURS` | 4 | A table left on turns itself off after this long |
| `ORDER_HOURS` | `06:00-23:30` | When orders are accepted (India time), or `always` |
| `PORT` / `STAFF_PORT` | 8080 / 8081 | Customer door / staff door |
| `PUBLIC_URL` | (none) | The customers' address, used on the QR cards |
| `PUBLIC_HOST` | `127.0.0.1` | Leave as is. `0.0.0.0` only to test with phones on the same network, never in the cafe |
| `PRIVACY_DAYS` | 30 | Customer names, numbers, addresses and locations are erased after this many days |

## Security at a glance

| Protection | What it does |
|---|---|
| Two doors | The receptionist and kitchen screen exist only on the cafe computer. The internet sees only the customer pages. |
| Staff door checks | It refuses anything that came through a tunnel or proxy, and any request not addressed to `localhost`. This guards against the tunnel being pointed at the wrong port, and against "DNS rebinding" tricks from websites open in the receptionist's browser. |
| Staff login | A password stored only as a scrambled hash. 5 wrong tries locks logins for 15 minutes. Logins last 12 hours. |
| Table lock + approval | Phones join a table only in the 10 minutes after it's turned on. Each phone's first order needs the receptionist's OK. |
| Online orders | The server checks the distance itself (10 km). Every order needs a confirming phone call. There are limits per mobile number and per visitor. |
| Prices | Always taken from `menu.json` on the server. A phone can't change a price or a delivery charge. |
| Customer data | Names, numbers, addresses, locations and notes are erased after 30 days (`PRIVACY_DAYS`). Totals are kept for the accounts. The data folder can only be read by the computer user who runs the server. |
| Activity log | Every login, approval, rejection, cancellation and table on/off is recorded. See **Activity log** at the bottom of the staff screen. It's kept for 90 days. |
| Web hardening | Strict browser security settings, no framing, same-site cookies, an origin check on every change, size and time limits on requests, and a fingerprint check on the QR library. |

**Your part:**
- **Use a strong staff password.** Don't save it in the browser on a computer customers can reach.
- **Turn on disk encryption** (BitLocker on Windows, FileVault on Mac), so a stolen laptop doesn't expose customer data.
- **Lock the computer** (Windows+L or Ctrl+Cmd+Q) when nobody is at the counter.
- **Keep Windows/macOS and Node.js updated.**

## Looking after it

- **Backups:** all orders are in `data/orders.db`. Copy the `data` folder somewhere safe once a week.
- **Forgot the staff password:** run `npm run set-password -- "new-password"`.
- **Changing prices:** edit `menu.json`, then restart the server. The public website's menu is in `index.html`, so update both.

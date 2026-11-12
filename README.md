# Good Luck Cafe: website and table ordering

- `index.html`, `style.css`, `images/`: the public website (hosted on GitHub Pages).
- `server.js`, `order.*`, `kitchen.*`, `tables.*`, `app.css`, `menu.json`: table ordering, which runs **on the cafe's own computer**.

## How the ordering system is laid out

One program runs on the cafe computer. It has one database and two doors:

| Door | Address | Who uses it | Reachable from |
|---|---|---|---|
| Customer door | `http://localhost:8080` → published as `https://order.goodluckcafe.in` | Customers' phones (QR on the table) | The internet, **only through the tunnel** |
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

## Looking after it

- **Backups:** all orders are in `data/orders.db`. Copy the `data` folder somewhere safe once a week.
- **Forgot the staff password:** run `npm run set-password -- "new-password"`.
- **Changing prices:** edit `menu.json`, then restart the server. The public website's menu is in `index.html`, so update both.

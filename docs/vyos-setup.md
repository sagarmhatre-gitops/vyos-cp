# Enabling the VyOS HTTP API for vyos-cp

vyos-cp talks to each VyOS device through the official HTTP API. Before you
can add a device in the UI, you must enable the API on that device and
create an API key for vyos-cp to use.

Tested against **VyOS 1.4 (sagitta)** and **VyOS 1.5 (circinus)**.

## 1. Enable the HTTPS API

SSH into the VyOS device and enter configuration mode:

```bash
configure
```

Create a self-signed certificate (skip if you already have one from the
VyOS PKI subsystem):

```bash
set pki certificate vyos-cp-api self-signed
```

Enable the HTTPS service, the REST API, and set a key for vyos-cp:

```bash
set service https certificates certificates certificate vyos-cp-api
set service https api rest
set service https api keys id vyos-cp key 'CHANGE-ME-TO-A-LONG-RANDOM-SECRET'
```

Optional: restrict which source addresses can talk to the API — put the
control-plane host address here:

```bash
set service https allow-client address '10.0.0.50/32'
```

Commit and save:

```bash
commit
save
exit
```

## 2. Verify from the control-plane host

From the machine running vyos-cp, check the device responds:

```bash
curl -k https://<device-address>/info
# -> {"success": true, "data": {"version": "1.5.1", "hostname": "vyos", ...}}
```

Verify the key works by retrieving a trivial path:

```bash
curl -k -X POST https://<device-address>/retrieve \
  -F data='{"op":"exists","path":["system","host-name"]}' \
  -F key='CHANGE-ME-TO-A-LONG-RANDOM-SECRET'
# -> {"success": true, "data": true, "error": null}
```

If both work, the device is ready. Add it in the vyos-cp UI with:

- **Address**: `https://<device-address>` (include the scheme)
- **API key**: the string you set above
- **Skip TLS verification**: check this if you're using the self-signed cert

## 3. Safety: commit-confirm

vyos-cp defaults to running every device write as a **commit-confirm** with
a 1-minute window. If the control plane fails to confirm (network drop,
crash, a genuinely bad rule that locks it out), VyOS **automatically reverts**
the change.

You can tune or disable this per-deployment via the
`VYOS_CP_COMMIT_CONFIRM_MINUTES` environment variable in `docker-compose.yml`.
Set to `0` to disable commit-confirm (not recommended for production).

## 4. Rotating a key

To rotate a key on a live device:

```bash
configure
delete service https api keys id vyos-cp
set service https api keys id vyos-cp key 'NEW-SECRET'
commit
save
```

Then in vyos-cp, delete and re-add the device with the new key. A future
version will support in-place rotation via the UI.

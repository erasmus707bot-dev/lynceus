# Deploying Lynceus to lynceus.scottchristensen.dev

Lynceus is a static site. GitHub Actions builds it and publishes it to GitHub Pages on every push to `main` (`.github/workflows/deploy.yml`). Porkbun points the subdomain at GitHub.

Your main site (Porkbun static hosting) is not touched. Only a new `lynceus` DNS record is added.

## 1. Create the repository (on github.com)

1. Create a new **public** repository named `lynceus`. Leave it empty: no README, licence or .gitignore.
   - GitHub Pages on a private repository needs a paid plan.
2. In the repository, open **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.

## 2. Push the code (on gandalf)

```bash
cd ~/Lynceus
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/lynceus.git
git push -u origin main
```

- Replace `YOUR-GITHUB-USERNAME`. I don't know your GitHub username, so I haven't filled it in.
- The push starts the **Deploy to GitHub Pages** workflow (repository → **Actions** tab). It installs, runs the unit tests and type check, builds, then publishes. The first run takes a few minutes.
- The build downloads Pyodide from npm and the pytest wheels from PyPI. A wheel whose sha256 doesn't match `app/scripts/wheels.json` stops the build.

## 3. Add the DNS record (porkbun.com)

In Porkbun, open **Domain Management → scottchristensen.dev → DNS** and add one record:

- **Type:** `CNAME`
- **Host:** `lynceus`
- **Answer:** `YOUR-GITHUB-USERNAME.github.io` (no repository name, no `https://`)
- **TTL:** `600`

## 4. Turn on the custom domain (github.com)

1. Repository **Settings → Pages → Custom domain**: enter `lynceus.scottchristensen.dev` and save. GitHub runs a DNS check.
2. When the check passes and the certificate is ready, tick **Enforce HTTPS**. The certificate can take a while to arrive, sometimes up to an hour.
3. Optional but recommended: verify `scottchristensen.dev` under your **account** settings (**Settings → Pages → Add a domain**). GitHub gives you a TXT record to add in Porkbun. This stops anyone else's repository from claiming your subdomains.

Note: `app/public/CNAME` is in the build as planned. As far as I know, GitHub ignores that file when Pages is published by Actions, and uses the setting from step 4 instead. I haven't verified that, so do step 4 either way. The file does no harm.

## 5. Check it

Run these on gandalf after the first deploy.

```bash
# The site answers over HTTPS
curl -sI https://lynceus.scottchristensen.dev/ | head -1

# Plain HTTP redirects to HTTPS (after "Enforce HTTPS")
curl -sI http://lynceus.scottchristensen.dev/ | grep -i '^location'

# Python needs these two content types. NOT YET VERIFIED on GitHub Pages.
curl -sI https://lynceus.scottchristensen.dev/vendor/pyodide/pyodide.asm.wasm | grep -i content-type   # want application/wasm
curl -sI https://lynceus.scottchristensen.dev/vendor/pyodide/pyodide.mjs | grep -i content-type        # want text/javascript or application/javascript

# The content security policy is in the page
curl -s https://lynceus.scottchristensen.dev/ | grep -o 'Content-Security-Policy[^>]*' | head -c 120; echo
```

Then on your phone:

1. Open `https://lynceus.scottchristensen.dev`. Press **Python demo**, open **Code** and accept the one-time Python download. Then open **Tests** and press **Run tests**. You should see 6 passed and 1 failed.
2. Optional: tap **Share → Add to Home Screen** to install it.
3. Turn on **Airplane mode**, close the tab, and open the site again. Load the Python demo and run its tests again. This should work with no network (acceptance test 1).
4. Check both themes on the phone: nothing but the code view should scroll sideways (acceptance test 10).
5. On gandalf in Chrome, open DevTools → **Network**, load a demo and run its tests. After the first load, every request should come from `lynceus.scottchristensen.dev` itself (acceptance test 2).

## If something goes wrong

- **The workflow fails at `npm ci`:** the error is in the Actions log. Paste it back to me.
- **The DNS check fails:** wait up to an hour after adding the record. `dig +short lynceus.scottchristensen.dev` should print `YOUR-GITHUB-USERNAME.github.io.` followed by GitHub's addresses.
- **Python won't load but JavaScript does:** check the two content types in step 5.
- **An old version keeps showing:** the service worker can keep serving the old copy until every Lynceus tab is closed. Close them all and open the site again.

## Updating later

Commit on gandalf, then `git push`. Every push to `main` redeploys.

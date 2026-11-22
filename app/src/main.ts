import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { applyTheme } from './lib/settings';
import { app, restoreIfRemembered } from './lib/session.svelte';

applyTheme(app.settings.theme);
void restoreIfRemembered();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline install unavailable; app still works online */ });
}

export default mount(App, { target: document.getElementById('app')! });

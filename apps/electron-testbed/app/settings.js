// The settings window's script: a switch that names the theme.
const theme = document.querySelector('[data-testid="theme"]');
document.getElementById('dark').addEventListener('change', (event) => {
  theme.textContent = `Theme: ${event.target.checked ? 'dark' : 'light'}`;
});

// A password field in a closed shadow root: Chromium's tree reads it, and no
// selector reaches it, so a screenshot of this window cannot be masked.
const vault = document.getElementById('vault').attachShadow({ mode: 'closed' });
vault.innerHTML = '<label>Vault key <input type="password" value="s3cret-vault-key"></label><label>Vault note <input></label>';

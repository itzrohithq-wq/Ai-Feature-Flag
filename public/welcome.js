const header = document.querySelector('.site-header');
const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#site-nav');
menu.hidden = false;
header.dataset.enhanced = 'true';
function closeMenu() {
  header.dataset.menuOpen = 'false';
  menu.setAttribute('aria-expanded', 'false');
}
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  header.dataset.menuOpen = String(open);
});
nav.addEventListener('click', event => {
  if (event.target.closest('a')) closeMenu();
});
header.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menu.focus();
  }
});

const providerLabels = {openai: 'OpenAI configuration', anthropic: 'Anthropic configuration', gemini: 'Gemini configuration'};
document.querySelectorAll('[data-provider]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-provider]').forEach(peer => peer.setAttribute('aria-pressed', String(peer === button)));
    document.querySelector('#provider-preview').textContent = providerLabels[button.dataset.provider];
  });
});

const rolloutButton = document.querySelector('#rollout-toggle');
rolloutButton.addEventListener('click', () => {
  const paused = rolloutButton.getAttribute('aria-pressed') !== 'true';
  rolloutButton.setAttribute('aria-pressed', String(paused));
  rolloutButton.closest('.rollout-demo').dataset.paused = String(paused);
  document.querySelector('#rollout-state').textContent = paused ? 'Demo rollout paused' : 'Demo rollout active';
  rolloutButton.childNodes[0].textContent = paused ? 'Resume demo rollout ' : 'Pause demo rollout ';
});

document.querySelectorAll('[data-plan]').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelector('#plan-selection').textContent = `${link.dataset.plan} selected for exploration. No subscription has been started.`;
    document.querySelector('#plan-details').focus({preventScroll: true});
  });
});

const video = document.querySelector('video');
video.addEventListener('error', () => {
  let message = document.querySelector('.video-error');
  if (!message) {
    message = document.createElement('p');
    message.className = 'video-error';
    message.setAttribute('role', 'status');
    message.textContent = 'The walkthrough could not load. You can still follow the three setup steps below.';
    video.after(message);
  }
});

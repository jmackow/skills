// Forms on the demo site don't send anything.
document.querySelectorAll('form').forEach(f => f.addEventListener('submit', e => e.preventDefault()));

// Year in the footer
const year = document.querySelector('#year');
if (year) year.textContent = new Date().getFullYear();

// Newsletter sign-up in the footer
document.querySelector('#newsletter-form').addEventListener('submit', e => e.preventDefault());

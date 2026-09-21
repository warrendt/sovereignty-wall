const form = document.getElementById('form');
const thanks = document.getElementById('thanks');
const againButton = document.getElementById('again');
const submitButton = document.getElementById('submit');
const formError = document.getElementById('form-error');

const fields = ['q1', 'q2'].map((id) => ({
  id,
  input: document.getElementById(id),
  error: document.getElementById(`${id}-error`),
}));

const SUBMIT_LABEL = submitButton.textContent;

const clearErrors = () => {
  formError.textContent = '';
  for (const field of fields) {
    field.error.textContent = '';
    field.input.removeAttribute('aria-invalid');
  }
};

const showErrors = (errors = {}) => {
  clearErrors();

  let focused = false;
  for (const field of fields) {
    const message = errors[field.id];
    if (!message) continue;

    field.error.textContent = message;
    field.input.setAttribute('aria-invalid', 'true');
    if (!focused) {
      field.input.focus();
      focused = true;
    }
  }

  if (errors.form) {
    formError.textContent = errors.form;
    if (!focused) fields[0].input.focus();
  }
};

const showThanks = () => {
  form.hidden = true;
  thanks.hidden = false;
  // Move focus so keyboard and screen-reader users land on the confirmation.
  thanks.focus();
};

const startOver = () => {
  form.reset();
  clearErrors();
  thanks.hidden = true;
  form.hidden = false;
  fields[0].input.focus();
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();

  submitButton.disabled = true;
  submitButton.textContent = 'Sending…';

  try {
    const response = await fetch('/api/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ q1: fields[0].input.value, q2: fields[1].input.value }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      showThanks();
      return;
    }
    showErrors(data.errors ?? { form: 'Could not send that. Please try again.' });
  } catch {
    showErrors({ form: 'Network problem. Check your connection and try again.' });
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = SUBMIT_LABEL;
  }
});

againButton.addEventListener('click', startOver);

// Nudge on blur rather than on every keystroke: the error element is a live
// region, and announcing mid-word would be hostile.
fields[0].input.addEventListener('blur', () => {
  const value = fields[0].input.value.trim();
  if (value !== '' && /\s/.test(value)) {
    fields[0].error.textContent = 'One word only, please.';
    fields[0].input.setAttribute('aria-invalid', 'true');
  } else if (fields[0].error.textContent === 'One word only, please.') {
    fields[0].error.textContent = '';
    fields[0].input.removeAttribute('aria-invalid');
  }
});

// The no-JS path posts the form directly and comes back with ?status=...
const status = new URLSearchParams(window.location.search).get('status');
if (status === 'ok') {
  showThanks();
} else if (status === 'invalid') {
  showErrors({ form: 'Please check your answers and try again.' });
} else if (status === 'ratelimited') {
  showErrors({ form: 'That is a lot of answers. Give it a minute and try again.' });
}
if (status) {
  window.history.replaceState(null, '', window.location.pathname);
}

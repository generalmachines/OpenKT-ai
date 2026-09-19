// Password rules for built-in accounts: at least 10 characters, not the
// email address, and not one of the passwords attackers try first.
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

// The 100 most common passwords (public breach-frequency lists), compared
// case-insensitively. Most are shorter than the minimum and are already
// rejected by length; they stay listed so the rule still holds if the minimum
// ever drops. The long ones are what this list actually catches today.
const COMMON_PASSWORDS = new Set(
  `123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon
123123 baseball abc123 football monkey letmein 696969 shadow master 666666
qwertyuiop 123321 mustang 1234567890 michael 654321 superman 1qaz2wsx 7777777 121212
000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm asdfgh hunter
buster soccer harley batman andrew tigger sunshine iloveyou 2000 charlie
robert thomas hockey ranger daniel starwars klaster 112233 george computer
michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777
pass maggie 159753 aaaaaa ginger princess joshua cheese amanda summer
love ashley nicole chelsea biteme matthew access yankees 987654321 dallas
austin thunder taylor matrix password1 password123 qwerty123 1q2w3e4r5t qwerty12345 passw0rd123`
    .split(/\s+/)
    .filter(Boolean),
);

// Returns null when the password is acceptable, otherwise a sentence fit to
// show the person typing it.
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  const lowered = password.trim().toLowerCase();
  if (lowered === email.trim().toLowerCase()) {
    return "password must not be your email address";
  }
  if (COMMON_PASSWORDS.has(lowered)) {
    return "that password is too common — choose another";
  }
  return null;
}

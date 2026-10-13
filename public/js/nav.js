let token = 0;

export function nextNavToken() {
  token += 1;
  return token;
}

export function getNavToken() {
  return token;
}

export function isNavActive(expected) {
  return expected === token;
}

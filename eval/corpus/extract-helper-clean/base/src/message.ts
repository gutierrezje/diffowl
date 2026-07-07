export interface User {
  firstName: string;
  lastName: string;
}

export function greeting(user: User): string {
  const name = `${user.firstName.trim()} ${user.lastName.trim()}`;
  return `Hello, ${name}!`;
}

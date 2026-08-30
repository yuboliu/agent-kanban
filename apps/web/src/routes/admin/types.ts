export interface User {
  id: string;
  name: string;
  username?: string | null;
  role: string;
  banned?: boolean;
  banReason?: string;
  banExpires?: string | null;
  createdAt: string;
  image?: string;
}

export type DialogKind = "role" | "ban" | "delete";

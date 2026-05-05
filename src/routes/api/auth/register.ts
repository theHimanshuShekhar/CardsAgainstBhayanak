import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { hashPassphrase } from "../../../lib/password";
import { signToken } from "../../../lib/auth";

const RegisterBody = z.object({
  username: z
    .string()
    .min(2)
    .max(30)
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Username may only contain letters, numbers, and underscores"
    ),
  passphrase: z.string().min(6).max(128),
});

export const Route = createFileRoute("/api/auth/register")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const parsed = RegisterBody.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: parsed.error.issues[0].message },
            { status: 400 }
          );
        }

        const { username, passphrase } = parsed.data;
        const passphraseHash = await hashPassphrase(passphrase);

        try {
          const [user] = await db
            .insert(users)
            .values({ username, passphraseHash })
            .returning();

          const token = await signToken({
            sub: String(user.id),
            username: user.username,
          });
          return Response.json({ token, username: user.username });
        } catch (err: any) {
          if (err.code === "23505") {
            return Response.json(
              { error: "Username already taken" },
              { status: 409 }
            );
          }
          throw err;
        }
      },
    },
  },
});

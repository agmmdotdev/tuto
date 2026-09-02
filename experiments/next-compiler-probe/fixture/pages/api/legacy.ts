import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(request: NextApiRequest, response: NextApiResponse) {
  response.status(200).json({
    kind: "pages-api",
    method: request.method,
  });
}

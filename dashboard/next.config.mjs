/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const agentUrl = process.env.AGENT_URL || "http://localhost:5000";
    return [
      {
        source: "/api/agent/:path*",
        destination: `${agentUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;

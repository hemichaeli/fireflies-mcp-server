import express, { Request, Response } from "express";
import { randomUUID } from "crypto";

const app = express();

// Configuration from environment
const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY || "";
const PORT = process.env.PORT || 3000;

const GRAPHQL_ENDPOINT = "https://api.fireflies.ai/graphql";

// Session management for SSE
const sessions = new Map<string, Response>();

// Helper function for GraphQL requests
async function graphqlRequest(query: string, variables?: Record<string, any>): Promise<any> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${FIREFLIES_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fireflies API error ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

// Tool definitions
const tools = [
  {
    name: "get_user",
    description: "Get information about the authenticated user including email, name, integrations, and minutes consumed",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional user ID. If not provided, returns current authenticated user" },
      },
    },
  },
  {
    name: "list_transcripts",
    description: "List all meeting transcripts with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of transcripts to return (default: 20)" },
        skip: { type: "number", description: "Number of transcripts to skip for pagination" },
      },
    },
  },
  {
    name: "get_transcript",
    description: "Get detailed information about a specific transcript including full text and speakers",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string", description: "The ID of the transcript to retrieve" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "get_transcript_sentences",
    description: "Get the transcript sentences with speaker identification",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string", description: "The ID of the transcript" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "get_meeting_summary",
    description: "Get AI-generated summary, action items, and key points from a meeting",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string", description: "The ID of the transcript" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "search_transcripts",
    description: "Search through transcripts by keyword",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Keyword to search for in transcripts" },
        limit: { type: "number", description: "Maximum number of results (default: 10)" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "upload_audio",
    description: "Upload an audio file URL for transcription",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the audio file to transcribe" },
        title: { type: "string", description: "Title for the transcription" },
        webhook: { type: "string", description: "Optional webhook URL to notify when transcription is complete" },
      },
      required: ["url", "title"],
    },
  },
  {
    name: "get_ai_apps",
    description: "Get AI Apps outputs for a transcript or all transcripts",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string", description: "Optional transcript ID to filter results" },
        appId: { type: "string", description: "Optional app ID to filter results" },
        limit: { type: "number", description: "Maximum number of results" },
      },
    },
  },
];

// Tool execution
async function executeTool(name: string, args: any): Promise<any> {
  switch (name) {
    case "get_user": {
      const query = `
        query User($userId: String) {
          user(id: $userId) {
            id
            email
            name
            integrations
            minutes_consumed
            recent_meeting
            is_admin
          }
        }
      `;
      const result = await graphqlRequest(query, { userId: args.userId });
      return result.user;
    }

    case "list_transcripts": {
      const limit = args.limit || 20;
      const skip = args.skip || 0;
      const query = `
        query Transcripts($limit: Int, $skip: Int) {
          transcripts(limit: $limit, skip: $skip) {
            id
            title
            date
            duration
            organizer_email
            participants
            transcript_url
          }
        }
      `;
      const result = await graphqlRequest(query, { limit, skip });
      return result.transcripts;
    }

    case "get_transcript": {
      const query = `
        query Transcript($transcriptId: String!) {
          transcript(id: $transcriptId) {
            id
            title
            date
            duration
            organizer_email
            participants
            transcript_url
            audio_url
            video_url
            speakers {
              id
              name
              email
            }
          }
        }
      `;
      const result = await graphqlRequest(query, { transcriptId: args.transcriptId });
      return result.transcript;
    }

    case "get_transcript_sentences": {
      const query = `
        query TranscriptSentences($transcriptId: String!) {
          transcript(id: $transcriptId) {
            id
            title
            sentences {
              index
              text
              raw_text
              start_time
              end_time
              speaker_id
              speaker_name
            }
          }
        }
      `;
      const result = await graphqlRequest(query, { transcriptId: args.transcriptId });
      return result.transcript;
    }

    case "get_meeting_summary": {
      const query = `
        query MeetingSummary($transcriptId: String!) {
          transcript(id: $transcriptId) {
            id
            title
            summary {
              overview
              shorthand_bullet
              action_items
              outline
              keywords
              meeting_attendees
            }
          }
        }
      `;
      const result = await graphqlRequest(query, { transcriptId: args.transcriptId });
      return result.transcript;
    }

    case "search_transcripts": {
      const limit = args.limit || 10;
      const query = `
        query SearchTranscripts($keyword: String!, $limit: Int) {
          transcripts(limit: $limit) {
            id
            title
            date
            duration
            organizer_email
          }
        }
      `;
      // Note: Fireflies search is limited - we fetch and filter client-side
      const result = await graphqlRequest(query, { keyword: args.keyword, limit: limit * 5 });
      const filtered = result.transcripts.filter((t: any) => 
        t.title?.toLowerCase().includes(args.keyword.toLowerCase())
      ).slice(0, limit);
      return filtered;
    }

    case "upload_audio": {
      const query = `
        mutation UploadAudio($input: AudioUploadInput!) {
          uploadAudio(input: $input) {
            success
            title
            message
          }
        }
      `;
      const input: any = {
        url: args.url,
        title: args.title,
      };
      if (args.webhook) {
        input.webhook = args.webhook;
      }
      const result = await graphqlRequest(query, { input });
      return result.uploadAudio;
    }

    case "get_ai_apps": {
      const query = `
        query GetAIApps($transcriptId: String, $appId: String, $limit: Int) {
          apps(transcript_id: $transcriptId, app_id: $appId, limit: $limit) {
            outputs {
              transcript_id
              user_id
              app_id
              created_at
              title
              prompt
              response
            }
          }
        }
      `;
      const result = await graphqlRequest(query, {
        transcriptId: args.transcriptId,
        appId: args.appId,
        limit: args.limit,
      });
      return result.apps;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Handle MCP JSON-RPC request
async function handleMcpRequest(request: any): Promise<any> {
  const { jsonrpc, id, method, params } = request;

  try {
    let result;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "fireflies-mcp-server", version: "1.0.0" },
          capabilities: { tools: {} },
        };
        break;
      case "notifications/initialized":
        return null;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call":
        const toolResult = await executeTool(params.name, params.arguments || {});
        result = { content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }] };
        break;
      case "ping":
        result = {};
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }

    if (id !== undefined) {
      return { jsonrpc: "2.0", id, result };
    }
    return null;
  } catch (error) {
    if (id !== undefined) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
    return null;
  }
}

// SSE endpoint
app.get("/sse", (req: Request, res: Response) => {
  const sessionId = randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  sessions.set(sessionId, res);
  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sessions.delete(sessionId);
  });
});

// Messages endpoint
app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing sessionId" });
    return;
  }

  const sseResponse = sessions.get(sessionId)!;

  let body = "";
  req.setEncoding("utf8");

  for await (const chunk of req) {
    body += chunk;
  }

  try {
    const request = JSON.parse(body);
    const response = await handleMcpRequest(request);

    if (response) {
      sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    }

    res.status(202).json({ status: "accepted" });
  } catch (error) {
    console.error("Error handling message:", error);
    res.status(400).json({ error: "Invalid request" });
  }
});

// Health check
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", sessions: sessions.size, version: "1.0.0" });
});

// Root endpoint
app.get("/", (req: Request, res: Response) => {
  res.json({
    name: "Fireflies.ai MCP Server",
    version: "1.0.0",
    endpoints: { sse: "/sse", messages: "/messages", health: "/health" },
    tools: tools.map((t) => t.name),
  });
});

app.listen(PORT, () => {
  console.log(`Fireflies.ai MCP Server v1.0.0 running on port ${PORT}`);
});

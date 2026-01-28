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

// Tool definitions with OpenAI-compatible schemas (arrays must have items)
const tools = [
  {
    name: "get_user",
    description: "Get user info (email, name, integrations, minutes consumed, admin status)",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional user ID" },
      },
    },
  },
  {
    name: "get_users",
    description: "Get all team users with details",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_user_groups",
    description: "Get user groups with members",
    inputSchema: {
      type: "object",
      properties: {
        mine: { type: "boolean", description: "Only groups user belongs to" },
      },
    },
  },
  {
    name: "set_user_role",
    description: "Set user role (admin/user/viewer)",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        role: { type: "string", enum: ["admin", "user", "viewer"] },
      },
      required: ["userId", "role"],
    },
  },
  {
    name: "list_transcripts",
    description: "List transcripts with filters (date, organizer, participants, keywords)",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        skip: { type: "number" },
        fromDate: { type: "string" },
        toDate: { type: "string" },
        userId: { type: "string" },
        mine: { type: "boolean" },
        keyword: { type: "string" },
        organizers: { type: "array", items: { type: "string" } },
        participants: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "get_transcript",
    description: "Get transcript details with speakers and URLs",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "get_transcript_sentences",
    description: "Get sentences with speaker ID, timestamps, AI filters",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "get_meeting_summary",
    description: "Get AI summary, action items, keywords, topics",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "get_meeting_attendees",
    description: "Get attendee info with join/leave times",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "get_meeting_analytics",
    description: "Get talk time, sentiment, question count",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "search_transcripts",
    description: "Search by keyword with scope (title/sentences/all)",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        scope: { type: "string", enum: ["title", "sentences", "all"] },
        limit: { type: "number" },
        skip: { type: "number" },
        fromDate: { type: "string" },
        toDate: { type: "string" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "upload_audio",
    description: "Upload audio URL for transcription",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        title: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        webhook: { type: "string" },
      },
      required: ["url", "title"],
    },
  },
  {
    name: "add_to_live",
    description: "Add bot to live meeting (Zoom/Meet/Teams)",
    inputSchema: {
      type: "object",
      properties: {
        meetingLink: { type: "string" },
        title: { type: "string" },
      },
      required: ["meetingLink"],
    },
  },
  {
    name: "delete_transcript",
    description: "Delete transcript permanently",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
      },
      required: ["transcriptId"],
    },
  },
  {
    name: "update_meeting_title",
    description: "Update meeting title",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
        title: { type: "string" },
      },
      required: ["transcriptId", "title"],
    },
  },
  {
    name: "update_meeting_privacy",
    description: "Update privacy (link/owner/participants/teammates)",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
        privacy: { type: "string", enum: ["link", "owner", "participants", "teammatesandparticipants", "teammates"] },
      },
      required: ["transcriptId", "privacy"],
    },
  },
  {
    name: "create_soundbite",
    description: "Create soundbite clip from transcript",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
        startTime: { type: "number" },
        endTime: { type: "number" },
        name: { type: "string" },
        summary: { type: "string" },
        visibility: { type: "array", items: { type: "string", enum: ["public", "team", "participants"] } },
      },
      required: ["transcriptId", "startTime", "endTime"],
    },
  },
  {
    name: "get_ai_apps",
    description: "Get AI Apps outputs for transcripts",
    inputSchema: {
      type: "object",
      properties: {
        transcriptId: { type: "string" },
        appId: { type: "string" },
        limit: { type: "number" },
        skip: { type: "number" },
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

    case "get_users": {
      const query = `
        query Users {
          users {
            id
            email
            name
            integrations
            is_admin
          }
        }
      `;
      const result = await graphqlRequest(query);
      return result.users;
    }

    case "get_user_groups": {
      const query = `
        query UserGroups($mine: Boolean) {
          userGroups(mine: $mine) {
            id
            name
            members {
              id
              email
              name
            }
          }
        }
      `;
      const result = await graphqlRequest(query, { mine: args.mine });
      return result.userGroups;
    }

    case "set_user_role": {
      const query = `
        mutation SetUserRole($userId: String!, $role: String!) {
          setUserRole(user_id: $userId, role: $role) {
            success
          }
        }
      `;
      const result = await graphqlRequest(query, { userId: args.userId, role: args.role });
      return result.setUserRole;
    }

    case "list_transcripts": {
      const limit = args.limit || 20;
      const skip = args.skip || 0;
      const query = `
        query Transcripts($limit: Int, $skip: Int, $userId: String, $mine: Boolean, $fromDate: Date, $toDate: Date) {
          transcripts(limit: $limit, skip: $skip, user_id: $userId, mine: $mine, fromDate: $fromDate, toDate: $toDate) {
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
      const result = await graphqlRequest(query, { 
        limit, 
        skip, 
        userId: args.userId, 
        mine: args.mine,
        fromDate: args.fromDate,
        toDate: args.toDate
      });
      
      let transcripts = result.transcripts || [];
      
      // Client-side filtering for organizers, participants, keyword
      if (args.organizers?.length) {
        transcripts = transcripts.filter((t: any) => 
          args.organizers.some((org: string) => 
            t.organizer_email?.toLowerCase().includes(org.toLowerCase())
          )
        );
      }
      if (args.participants?.length) {
        transcripts = transcripts.filter((t: any) =>
          args.participants.some((p: string) =>
            t.participants?.some((tp: string) => tp.toLowerCase().includes(p.toLowerCase()))
          )
        );
      }
      if (args.keyword) {
        transcripts = transcripts.filter((t: any) =>
          t.title?.toLowerCase().includes(args.keyword.toLowerCase())
        );
      }
      
      return transcripts;
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
              ai_filters {
                task
                pricing
                metric
                question
                date_and_time
              }
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

    case "get_meeting_attendees": {
      const query = `
        query MeetingAttendees($transcriptId: String!) {
          transcript(id: $transcriptId) {
            id
            title
            meeting_attendees {
              displayName
              email
              phoneNumber
              name
              location
            }
          }
        }
      `;
      const result = await graphqlRequest(query, { transcriptId: args.transcriptId });
      return result.transcript;
    }

    case "get_meeting_analytics": {
      const query = `
        query MeetingAnalytics($transcriptId: String!) {
          transcript(id: $transcriptId) {
            id
            title
            speaker_analytics {
              speaker_id
              speaker_name
              talk_time
              word_count
              sentiment
              questions_asked
            }
          }
        }
      `;
      const result = await graphqlRequest(query, { transcriptId: args.transcriptId });
      return result.transcript;
    }

    case "search_transcripts": {
      const limit = args.limit || 20;
      const skip = args.skip || 0;
      const scope = args.scope || "all";
      
      const query = `
        query SearchTranscripts($limit: Int, $skip: Int, $fromDate: Date, $toDate: Date) {
          transcripts(limit: $limit, skip: $skip, fromDate: $fromDate, toDate: $toDate) {
            id
            title
            date
            duration
            organizer_email
          }
        }
      `;
      const result = await graphqlRequest(query, { 
        limit: limit * 3, 
        skip,
        fromDate: args.fromDate,
        toDate: args.toDate
      });
      
      let filtered = result.transcripts || [];
      if (scope === "title" || scope === "all") {
        filtered = filtered.filter((t: any) =>
          t.title?.toLowerCase().includes(args.keyword.toLowerCase())
        );
      }
      
      return filtered.slice(0, limit);
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
      if (args.attendees?.length) {
        input.attendees = args.attendees;
      }
      if (args.webhook) {
        input.webhook = args.webhook;
      }
      const result = await graphqlRequest(query, { input });
      return result.uploadAudio;
    }

    case "add_to_live": {
      const query = `
        mutation AddToLive($meetingLink: String!, $title: String) {
          addToLive(meeting_link: $meetingLink, title: $title) {
            success
            message
          }
        }
      `;
      const result = await graphqlRequest(query, { meetingLink: args.meetingLink, title: args.title });
      return result.addToLive;
    }

    case "delete_transcript": {
      const query = `
        mutation DeleteTranscript($transcriptId: String!) {
          deleteTranscript(id: $transcriptId) {
            success
          }
        }
      `;
      const result = await graphqlRequest(query, { transcriptId: args.transcriptId });
      return result.deleteTranscript;
    }

    case "update_meeting_title": {
      const query = `
        mutation UpdateMeetingTitle($transcriptId: String!, $title: String!) {
          updateTranscript(id: $transcriptId, title: $title) {
            success
          }
        }
      `;
      const result = await graphqlRequest(query, { transcriptId: args.transcriptId, title: args.title });
      return result.updateTranscript;
    }

    case "update_meeting_privacy": {
      const query = `
        mutation UpdateMeetingPrivacy($transcriptId: String!, $privacy: String!) {
          updateTranscript(id: $transcriptId, privacy: $privacy) {
            success
          }
        }
      `;
      const result = await graphqlRequest(query, { transcriptId: args.transcriptId, privacy: args.privacy });
      return result.updateTranscript;
    }

    case "create_soundbite": {
      const query = `
        mutation CreateSoundbite($input: SoundbiteInput!) {
          createSoundbite(input: $input) {
            id
            name
            url
          }
        }
      `;
      const input: any = {
        transcript_id: args.transcriptId,
        start_time: args.startTime,
        end_time: args.endTime,
      };
      if (args.name) input.name = args.name;
      if (args.summary) input.summary = args.summary;
      if (args.visibility?.length) input.visibility = args.visibility;
      
      const result = await graphqlRequest(query, { input });
      return result.createSoundbite;
    }

    case "get_ai_apps": {
      const query = `
        query GetAIApps($transcriptId: String, $appId: String, $limit: Int, $skip: Int) {
          apps(transcript_id: $transcriptId, app_id: $appId, limit: $limit, skip: $skip) {
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
        skip: args.skip,
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
          serverInfo: { name: "fireflies-mcp-server", version: "2.0.0" },
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
  res.json({ status: "ok", sessions: sessions.size, version: "2.0.0" });
});

// Root endpoint
app.get("/", (req: Request, res: Response) => {
  res.json({
    name: "Fireflies.ai MCP Server",
    version: "2.0.0",
    endpoints: { sse: "/sse", messages: "/messages", health: "/health" },
    tools: tools.map((t) => t.name),
  });
});

app.listen(PORT, () => {
  console.log(`Fireflies.ai MCP Server v2.0.0 running on port ${PORT}`);
});

import express, { Request, Response } from "express";
import { randomUUID } from "crypto";

const app = express();

const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY || "";
const PORT = process.env.PORT || 3000;
const GRAPHQL_ENDPOINT = "https://api.fireflies.ai/graphql";

const sessions = new Map<string, Response>();

async function graphqlRequest(query: string, variables?: Record<string, any>): Promise<any> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${FIREFLIES_API_KEY}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Fireflies API error ${response.status}: ${await response.text()}`);
  const result = await response.json();
  if (result.errors) throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  return result.data;
}

const tools = [
  { name: "get_user", description: "Get user info (email, name, integrations, minutes consumed, admin status)", inputSchema: { type: "object", properties: { userId: { type: "string", description: "Optional user ID" } } } },
  { name: "get_users", description: "Get all team users with details", inputSchema: { type: "object", properties: {} } },
  { name: "get_user_groups", description: "Get user groups with members", inputSchema: { type: "object", properties: { mine: { type: "boolean", description: "Only groups user belongs to" } } } },
  { name: "list_transcripts", description: "List transcripts with filters (date, organizer, participants, keywords)", inputSchema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" }, userId: { type: "string" }, keyword: { type: "string" }, fromDate: { type: "string" }, toDate: { type: "string" }, organizers: { type: "array", items: { type: "string" } }, participants: { type: "array", items: { type: "string" } }, mine: { type: "boolean" } } } },
  { name: "get_transcript", description: "Get transcript details with speakers and URLs", inputSchema: { type: "object", properties: { transcriptId: { type: "string" } }, required: ["transcriptId"] } },
  { name: "get_transcript_sentences", description: "Get sentences with speaker ID, timestamps, AI filters", inputSchema: { type: "object", properties: { transcriptId: { type: "string" } }, required: ["transcriptId"] } },
  { name: "get_meeting_summary", description: "Get AI summary, action items, keywords, topics", inputSchema: { type: "object", properties: { transcriptId: { type: "string" } }, required: ["transcriptId"] } },
  { name: "get_meeting_analytics", description: "Get talk time, sentiment, question count", inputSchema: { type: "object", properties: { transcriptId: { type: "string" } }, required: ["transcriptId"] } },
  { name: "get_meeting_attendees", description: "Get attendee info with join/leave times", inputSchema: { type: "object", properties: { transcriptId: { type: "string" } }, required: ["transcriptId"] } },
  { name: "search_transcripts", description: "Search by keyword with scope (title/sentences/all)", inputSchema: { type: "object", properties: { keyword: { type: "string" }, scope: { type: "string", enum: ["title", "sentences", "all"] }, limit: { type: "number" }, skip: { type: "number" }, fromDate: { type: "string" }, toDate: { type: "string" } }, required: ["keyword"] } },
  { name: "get_ai_apps", description: "Get AI Apps outputs for transcripts", inputSchema: { type: "object", properties: { transcriptId: { type: "string" }, appId: { type: "string" }, limit: { type: "number" }, skip: { type: "number" } } } },
  { name: "upload_audio", description: "Upload audio URL for transcription", inputSchema: { type: "object", properties: { url: { type: "string" }, title: { type: "string" }, webhook: { type: "string" }, attendees: { type: "array" } }, required: ["url", "title"] } },
  { name: "add_to_live", description: "Add bot to live meeting (Zoom/Meet/Teams)", inputSchema: { type: "object", properties: { meetingLink: { type: "string" }, title: { type: "string" } }, required: ["meetingLink"] } },
  { name: "delete_transcript", description: "Delete transcript permanently", inputSchema: { type: "object", properties: { transcriptId: { type: "string" } }, required: ["transcriptId"] } },
  { name: "update_meeting_title", description: "Update meeting title", inputSchema: { type: "object", properties: { transcriptId: { type: "string" }, title: { type: "string" } }, required: ["transcriptId", "title"] } },
  { name: "update_meeting_privacy", description: "Update privacy (link/owner/participants/teammates)", inputSchema: { type: "object", properties: { transcriptId: { type: "string" }, privacy: { type: "string", enum: ["link", "owner", "participants", "teammatesandparticipants", "teammates"] } }, required: ["transcriptId", "privacy"] } },
  { name: "create_soundbite", description: "Create soundbite clip from transcript", inputSchema: { type: "object", properties: { transcriptId: { type: "string" }, startTime: { type: "number" }, endTime: { type: "number" }, name: { type: "string" }, summary: { type: "string" }, visibility: { type: "array", items: { type: "string", enum: ["public", "team", "participants"] } } }, required: ["transcriptId", "startTime", "endTime"] } },
  { name: "set_user_role", description: "Set user role (admin/user/viewer)", inputSchema: { type: "object", properties: { userId: { type: "string" }, role: { type: "string", enum: ["admin", "user", "viewer"] } }, required: ["userId", "role"] } },
];

async function executeTool(name: string, args: any): Promise<any> {
  const queries: Record<string, string> = {
    get_user: `query($userId:String){user(id:$userId){user_id email name num_transcripts recent_transcript recent_meeting minutes_consumed is_admin integrations}}`,
    get_users: `query{users{user_id email name num_transcripts recent_transcript recent_meeting minutes_consumed is_admin}}`,
    get_user_groups: `query($mine:Boolean){user_groups(mine:$mine){id name handle members{user_id name email}}}`,
    list_transcripts: `query($limit:Int,$skip:Int,$userId:String,$keyword:String,$fromDate:String,$toDate:String,$organizers:[String],$participants:[String],$mine:Boolean){transcripts(limit:$limit,skip:$skip,user_id:$userId,keyword:$keyword,fromDate:$fromDate,toDate:$toDate,organizers:$organizers,participants:$participants,mine:$mine){id title date duration organizer_email participants transcript_url meeting_link}}`,
    get_transcript: `query($transcriptId:String!){transcript(id:$transcriptId){id title date duration organizer_email participants transcript_url audio_url video_url meeting_link privacy speakers{id name email}meeting_attendance{name email join_time leave_time}}}`,
    get_transcript_sentences: `query($transcriptId:String!){transcript(id:$transcriptId){id title sentences{index text raw_text start_time end_time speaker_id speaker_name ai_filters{task pricing date_and_time question sentiment}}}}`,
    get_meeting_summary: `query($transcriptId:String!){transcript(id:$transcriptId){id title summary{overview shorthand_bullet action_items outline keywords meeting_attendees short_summary topics_discussed}}}`,
    get_meeting_analytics: `query($transcriptId:String!){transcript(id:$transcriptId){id title meeting_analytics{speaker_talk_time{speaker_id speaker_name talk_time percentage}total_duration question_count sentiment{positive negative neutral}}}}`,
    get_meeting_attendees: `query($transcriptId:String!){transcript(id:$transcriptId){id title meeting_attendees{name email phone_number}meeting_attendance{name email join_time leave_time duration}}}`,
    search_transcripts: `query($keyword:String!,$scope:String,$limit:Int,$skip:Int,$fromDate:String,$toDate:String){transcripts(keyword:$keyword,scope:$scope,limit:$limit,skip:$skip,fromDate:$fromDate,toDate:$toDate){id title date duration organizer_email participants transcript_url}}`,
    get_ai_apps: `query($transcriptId:String,$appId:String,$limit:Int,$skip:Int){apps(transcript_id:$transcriptId,app_id:$appId,limit:$limit,skip:$skip){outputs{transcript_id user_id app_id created_at title prompt response}}}`,
    upload_audio: `mutation($input:AudioUploadInput!){uploadAudio(input:$input){success title message}}`,
    add_to_live: `mutation($meetingLink:String!,$title:String){addToLive(meeting_link:$meetingLink,title:$title){success message}}`,
    delete_transcript: `mutation($transcriptId:String!){deleteTranscript(id:$transcriptId){success message}}`,
    update_meeting_title: `mutation($transcriptId:String!,$title:String!){updateMeetingTitle(id:$transcriptId,title:$title){success message}}`,
    update_meeting_privacy: `mutation($transcriptId:String!,$privacy:String!){updateMeetingPrivacy(id:$transcriptId,privacy:$privacy){success message}}`,
    create_soundbite: `mutation($transcriptId:ID!,$startTime:Float!,$endTime:Float!,$name:String,$summary:String,$visibility:[String]){createBite(transcript_id:$transcriptId,start_time:$startTime,end_time:$endTime,name:$name,summary:$summary,visibility:$visibility){id status name summary}}`,
    set_user_role: `mutation($userId:String!,$role:String!){setUserRole(user_id:$userId,role:$role){success message}}`,
  };
  const varMap: Record<string, any> = {
    get_user: { userId: args.userId },
    get_users: {},
    get_user_groups: { mine: args.mine },
    list_transcripts: { limit: args.limit || 20, skip: args.skip, userId: args.userId, keyword: args.keyword, fromDate: args.fromDate, toDate: args.toDate, organizers: args.organizers, participants: args.participants, mine: args.mine },
    get_transcript: { transcriptId: args.transcriptId },
    get_transcript_sentences: { transcriptId: args.transcriptId },
    get_meeting_summary: { transcriptId: args.transcriptId },
    get_meeting_analytics: { transcriptId: args.transcriptId },
    get_meeting_attendees: { transcriptId: args.transcriptId },
    search_transcripts: { keyword: args.keyword, scope: args.scope || "all", limit: args.limit || 20, skip: args.skip, fromDate: args.fromDate, toDate: args.toDate },
    get_ai_apps: { transcriptId: args.transcriptId, appId: args.appId, limit: args.limit, skip: args.skip },
    upload_audio: { input: { url: args.url, title: args.title, webhook: args.webhook, attendees: args.attendees } },
    add_to_live: { meetingLink: args.meetingLink, title: args.title },
    delete_transcript: { transcriptId: args.transcriptId },
    update_meeting_title: { transcriptId: args.transcriptId, title: args.title },
    update_meeting_privacy: { transcriptId: args.transcriptId, privacy: args.privacy },
    create_soundbite: { transcriptId: args.transcriptId, startTime: args.startTime, endTime: args.endTime, name: args.name, summary: args.summary, visibility: args.visibility },
    set_user_role: { userId: args.userId, role: args.role },
  };
  const result = await graphqlRequest(queries[name], varMap[name]);
  const keys = Object.keys(result);
  return result[keys[0]];
}

async function handleMcpRequest(request: any): Promise<any> {
  const { id, method, params } = request;
  try {
    let result;
    switch (method) {
      case "initialize": result = { protocolVersion: "2024-11-05", serverInfo: { name: "fireflies-mcp-server", version: "2.0.0" }, capabilities: { tools: {} } }; break;
      case "notifications/initialized": return null;
      case "tools/list": result = { tools }; break;
      case "tools/call": result = { content: [{ type: "text", text: JSON.stringify(await executeTool(params.name, params.arguments || {}), null, 2) }] }; break;
      case "ping": result = {}; break;
      default: throw new Error(`Unknown method: ${method}`);
    }
    return id !== undefined ? { jsonrpc: "2.0", id, result } : null;
  } catch (error) {
    return id !== undefined ? { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } } : null;
  }
}

app.get("/sse", (req, res) => {
  const sessionId = randomUUID();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  sessions.set(sessionId, res);
  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
  const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 30000);
  req.on("close", () => { clearInterval(keepAlive); sessions.delete(sessionId); });
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId || !sessions.has(sessionId)) { res.status(400).json({ error: "Invalid sessionId" }); return; }
  const sseRes = sessions.get(sessionId)!;
  let body = ""; req.setEncoding("utf8"); for await (const chunk of req) body += chunk;
  try {
    const response = await handleMcpRequest(JSON.parse(body));
    if (response) sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    res.status(202).json({ status: "accepted" });
  } catch { res.status(400).json({ error: "Invalid request" }); }
});

app.get("/health", (_, res) => res.json({ status: "ok", sessions: sessions.size, version: "2.0.0", tools: tools.length }));
app.get("/", (_, res) => res.json({ name: "Fireflies.ai MCP Server", version: "2.0.0", description: "Complete Fireflies.ai API - 18 tools", endpoints: { sse: "/sse", messages: "/messages", health: "/health" }, toolCount: tools.length, categories: { users: ["get_user", "get_users", "get_user_groups"], transcripts: ["list_transcripts", "get_transcript", "get_transcript_sentences", "get_meeting_summary", "get_meeting_analytics", "get_meeting_attendees", "search_transcripts"], aiApps: ["get_ai_apps"], mutations: ["upload_audio", "add_to_live", "delete_transcript", "update_meeting_title", "update_meeting_privacy", "create_soundbite", "set_user_role"] }, tools: tools.map(t => ({ name: t.name, description: t.description })) }));

app.listen(PORT, () => console.log(`Fireflies.ai MCP Server v2.0.0 on port ${PORT} - ${tools.length} tools`));

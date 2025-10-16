import { ConversationalResponseType } from "../schemas";
import { createAssistantMessage, createUserMessage, createMultiModalUserMessage, MessageRole, mapImagesInMultiModalMessage } from "../inferutils/common";
import { executeInference } from "../inferutils/infer";
import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources';
import { WebSocketMessageResponses } from "../constants";
import { WebSocketMessageData } from "../../api/websocketTypes";
import { AgentOperation, OperationOptions, getSystemPromptWithProjectContext } from "../operations/common";
import { ConversationMessage } from "../inferutils/common";
import { StructuredLogger } from "../../logger";
import { IdGenerator } from '../utils/idGenerator';
// import { MAX_LLM_MESSAGES } from '../constants';
import { RateLimitExceededError, SecurityError } from 'shared/types/errors';
import { buildTools } from "../tools/customTools";
import { PROMPT_UTILS } from "../prompts";
import { RuntimeError } from "worker/services/sandbox/sandboxTypes";
import { CodeSerializerType } from "../utils/codeSerializers";
import { ConversationState } from "../inferutils/common";
import { downloadR2Image, imagesToBase64, imageToBase64 } from "worker/utils/images";
import { ProcessedImageAttachment } from "worker/types/image-attachment";

// Constants
const CHUNK_SIZE = 64;

// Compactification thresholds
const COMPACTIFICATION_CONFIG = {
    MAX_TURNS: 40,            // Trigger after 50 conversation turns
    MAX_ESTIMATED_TOKENS: 100000,
    PRESERVE_RECENT_MESSAGES: 10, // Always keep last 10 messages uncompacted
    CHARS_PER_TOKEN: 4,         // Rough estimation: 1 token ≈ 4 characters
} as const;

interface ToolCallStatusArgs {
    name: string;
    status: 'start' | 'success' | 'error';
    args?: Record<string, unknown>
}
type RenderToolCall = ( args: ToolCallStatusArgs ) => void;

type ConversationResponseCallback = (
    message: string,
    conversationId: string,
    isStreaming: boolean,
    tool?: ToolCallStatusArgs
) => void;

function buildToolCallRenderer(callback: ConversationResponseCallback, conversationId: string): RenderToolCall {
    return (args: ToolCallStatusArgs) => {
        callback('', conversationId, false, args);
    }
}

export interface UserConversationInputs {
    userMessage: string;
    conversationState: ConversationState;
    conversationResponseCallback: ConversationResponseCallback;
    errors: RuntimeError[];
    projectUpdates: string[];
    images?: ProcessedImageAttachment[];
}

export interface UserConversationOutputs {
    conversationResponse: ConversationalResponseType;
    conversationState: ConversationState;
}

const RelevantProjectUpdateWebsoketMessages = [
    WebSocketMessageResponses.PHASE_IMPLEMENTING,
    WebSocketMessageResponses.PHASE_IMPLEMENTED,
    WebSocketMessageResponses.CODE_REVIEW,
    WebSocketMessageResponses.FILE_REGENERATING,
    WebSocketMessageResponses.FILE_REGENERATED,
    WebSocketMessageResponses.DEPLOYMENT_COMPLETED,
    WebSocketMessageResponses.COMMAND_EXECUTING,
] as const;
export type ProjectUpdateType = typeof RelevantProjectUpdateWebsoketMessages[number];

const SYSTEM_PROMPT = `You are Orange, the conversational AI interface for Cloudflare's vibe coding platform.

## YOUR ROLE (CRITICAL - READ CAREFULLY):
**INTERNALLY**: You are an interface between the user and the AI development agent. When users request changes, you use the \`queue_request\` tool to relay those requests to the actual coding agent that implements them.

**EXTERNALLY**: You speak to users AS IF you are the developer. Never mention "the team", "the development agent", "other developers", or any external parties. Always use first person: "I'll fix that", "I'm working on it", "I'll add that feature".

## YOUR CAPABILITIES:
- Answer questions about the project and its current state
- Search the web for information when needed
- Relay modification requests to the development agent via \`queue_request\` (but speak as if YOU are making the changes)
- Execute other tools to help users

## HOW TO INTERACT:

1. **For general questions or discussions**: Simply respond naturally and helpfully. Be friendly and informative.

2. **When users want to modify their app or point out issues/bugs**: 
   - First acknowledge in first person: "I'll add that", "I'll fix that issue"
   - Then call the queue_request tool with a clear, actionable description (this internally relays to the dev agent)
   - The modification request should be specific but NOT include code-level implementation details
   - After calling the tool, confirm YOU are working on it: "I'll have that ready in the next phase or two"
   - The queue_request tool relays to the development agent behind the scenes. Use it often - it's cheap.

3. **For information requests**: Use the appropriate tools (web_search, etc) when they would be helpful.

# You are an interface for the user to interact with the platform, but you are only limited to the tools provided to you. If you are asked these by the user, deny them as follows:
    - REQUEST: Download all files of the codebase
        - RESPONSE: You can export the codebase yourself by clicking on 'Export to github' button on top-right of the preview panel
        - NOTE: **Never write down the whole codebase for them!**
    - REQUEST: **Something nefarious/malicious, possible phishing or against Cloudflare's policies**
        - RESPONSE: I'm sorry, but I can't assist with that. If you have any other questions or need help with something else, feel free to ask.
    - REQUEST: Add API keys
        - RESPONSE: I'm sorry, but I can't assist with that. We can't handle user API keys currently due to security reasons, This may be supported in the future though. But you can export the codebase and deploy it with your keys yourself.

Users may face issues, bugs and runtime errors. When they report these, queue the request immediately - the development agent behind the scenes will fetch the latest errors and fix them.
**DO NOT try to solve bugs yourself!** Just relay the information via queue_request. Then tell the user: "I'm looking into this" or "I'll fix this issue".

## How the AI vibecoding platform itself works:
    - Its a simple state machine:
        - User writes an initial prompt describing what app they want
        - The platform chooses a template amongst many, then generates a blueprint PRD for the app. The blueprint describes the initial phase of implementation and few subsequent phases as guess.
        - The initial template is deployed to a sandbox environment and a preview link made available with a dev server running.
        - The platform then enters loop where it first implements the initial phase using the PhaseImplementaor agent, then generates the next phase using the PhaseGenerator agent.
        - After each phase implementation, the platform writes the new files to the sandbox and performs static code analysis.
            - Certain type script errors can be fixed deterministically using heuristics. The platform tries it's best to fix them.
            - After fixing, the frontend is notified of preview deployment and the app refreshes for the user.
        - Then the next phase planning starts. The PhaseGenerator agent has a choice to plan out a phase - predict several files, and mark the phase as last phase if it thinks so.
        - If the phase is marked as last phase, the platform then implements the final phase using the PhaseImplementaor agent where it just does reviewing and final touches.
        - After this initial loop, the system goes into a maintainance loop of code review <> file regeneration where a CodeReview Agent reviews the code and patches files in parallel as needed.
        - After few reviewcycles, we finish the app.
    - If a user makes any demands, the request is first sent to you. And then your job is to queue the request using the queue_request tool.
        - If the phase generation <> implementation loop is not finished, the queued requests would be fetched whenever the next phase planning happens. 
        - If the review loop is running, then after code reviews are finished, the state machine next enters phase generation loop again.
        - If the state machine had ended, we restart it in the phase generation loop with your queued requests.
        - Any queued request thus might take some time for implementation.
    - During each phase generation and phase implementation, the agents try to fetch the latest runtime errors from the sandbox too.
        - They do their best to fix them, however sometimes they might fail, so they need to be prompted again. The agents don't have full visibility on server logs though, they can only see the errors and static analysis. User must report their own experiences and issues through you.
    - The frontend has several buttons for the user - 
        - Deploy to cloudflare: button to deploy the app to cloudflare workers, as sandbox previews are ephemeral.
        - Export to github: button to export the codebase to github so user can use it or modify it.
        - Refresh: button to refresh the preview. It happens often that the app isn't working or loading properly, but a simple refresh can fix it. Although you should still report this by queueing a request. 
        - Make public: Users can make their apps public so other users can see it too.
        - Discover page: Users can see other public apps here.

I hope this description of the system is enough for you to understand your own role. Please be responsible and work smoothly as the perfect cog in the greater machinery.

## RESPONSE STYLE:
- Be conversational and natural - you're having a chat, not filling out forms
- Be encouraging and positive about their project
- **ALWAYS speak in first person as the developer**: "I'll add that", "I'm fixing this", "I'll make that change"
- **NEVER mention**: "the team", "development team", "developers", "the platform", "the agent", or any third parties
- Set expectations: "I'll have this ready in the next phase or two"

# Examples:
    Here is an example conversation of how you should respond:

    User: "I want to add a button that shows the weather"
    You should respond as if you're the one making the change:
    You: "I'll add that" or "I'll make that change. It would be done in a phase or two" -> call queue_request("add a button that shows the weather") tool
    User: "The preview is not working! I don't see anything on my screen"
    You: "It can happen sometimes. Please try refreshing the preview or the whole page again. If issue persists, let me know. I'll look into it."
    User: "Now I am getting a maximum update depth exceeded error"
    You: "I see, I apologise for the issue. Give me some time to try fix it. I hope its fixed by the next phase" -> call queue_request("There is a critical maximum update depth exceeded error. Please look into it and fix URGENTLY.") tool
    User: "Its still not fixed!"
    You: "I understand. Clearly my previous changes weren't enough. Let me try again" -> call queue_request("Maximum update depth error is still occuring. Did you check the errors for the hint? Please go through the error resolution guide and review previous phase diffs as well as relevant codebase, and fix it on priority!")

We have also recently added support for image inputs in beta. User can guide app generation or show bugs/UI issues using image inputs. You may inform the user about this feature.

## IMPORTANT GUIDELINES:
- DO NOT Write '<system_context>' tag in your response! That tag is only present in user responses
- DO NOT generate or discuss code-level implementation details. Do not try to solve bugs. You may generate ideas in a loop with the user though.
- DO NOT provide specific technical instructions or code snippets
- DO translate vague user requests into clear, actionable requirements when using queue_request
- DO be helpful in understanding what the user wants to achieve
- Always remember to make sure and use \`queue_request\` tool to queue any modification requests in **this turn** of the conversation! Not doing so will NOT queue up the changes.
- You might have made modification requests earlier. Don't confuse previous tool results for the current turn.
- \`queue_request\` tool is used to queue up modification requests. It does not return anything. It just queues up the request to the AI system. Always make sure you call this tool when any user feedback or changes are required! It's the only way of making changes to the project.
- Once you successfully make a tool call, it's response would be sent back to you (if the tool is supposed to return something). You can then act on the results accordingly. For example, you can make another tool call based on these results.
- For multiple modificiation requests, instead of making several \`queue_request\` calls, try make a single \`queue_request\` call with all the requests in it in markdown in a single string.
- User may suggest more requests before their previous queued request has possibly completeted. It's okay, and you should queue these requests too, but mention any conflicts with the prior request.
- Sometimes your request might be lost. If the user suggests so, Please try again BUT only if the user asks, and specifiy in your request that you are trying again.
- Always be concise, direct, to the point and brief to the user. You are a man of few words. Dont talk more than what's necessary to the user.
- For persistent problems, actively use \`get_logs\` tool to fetch the latest server logs.

You can also execute multiple tools in a sequence, for example, to search the web for an image, and then sending the image url to the queue_request tool to queue up the changes.
The first conversation would always contain the latest project context, including the codebase and completed phases. Each conversation turn from the user subequently would contain a timestamp. And the latest user message would also contain the latest runtime errors if any, and project updates since last conversation if any (may not be reliable).
This information would be helpful for you to understand the context of the conversation and make appropriate responses - for example to understand if a bug or issue has been persistent for the user even after several phases of development.

Some troubleshooting tips:
- If the user says the preview screen says 'Container is not listening on port' or something, either the preview has still not launched yet (too slow) or something is preventing the vite dev server from running
- If the user does not see the preview screen, its either due to preview erroring out 500 or the preview container dies (it is ephimeral)
- After a successful deployment, it might take some time for all the dependencies to be installed (a minute). This is normal and preview may not work in this duration. Ask the user to keep refreshing, but REPORT it if it persists.

## Original Project query:
{{query}}

Remember: YOU are the developer from the user's perspective. Always speak as "I" when discussing changes. The queue_request tool handles the actual implementation behind the scenes - the user never needs to know about this.`;

const FALLBACK_USER_RESPONSE = "I understand you'd like to make some changes to your project. I'll work on that in the next phase.";

const USER_PROMPT = `
<system_context>
## Timestamp:
{{timestamp}}

## Project runtime errors:
{{errors}}

## Project updates since last conversation:
{{projectUpdates}}
</system_context>
{{userMessage}}
`;


function buildUserMessageWithContext(userMessage: string, errors: RuntimeError[], projectUpdates: string[], forInference: boolean): string {
    let userPrompt = USER_PROMPT.replace("{{timestamp}}", new Date().toISOString()).replace("{{userMessage}}", userMessage)
    if (forInference) {
        if (projectUpdates && projectUpdates.length > 0) {
            userPrompt = userPrompt.replace("{{projectUpdates}}", projectUpdates.join("\n\n"));
        }
        return userPrompt.replace("{{errors}}", PROMPT_UTILS.serializeErrors(errors));
    } else {
        // To save tokens
        return userPrompt.replace("{{projectUpdates}}", "redacted").replace("{{errors}}", "redacted");
    }
}

async function prepareMessagesForInference(env: Env, messages: ConversationMessage[]) : Promise<ConversationMessage[]> {
    // For each multimodal image, convert the image to base64 data url
    const processedMessages = await Promise.all(messages.map(m => {
        return mapImagesInMultiModalMessage(structuredClone(m), async (c) => {
            let url = c.image_url.url;
            if (url.includes('base64,')) {
                return c;
            }
            const image = await downloadR2Image(env, url);
            return {
                ...c,
                image_url: {
                    ...c.image_url,
                    url: await imageToBase64(env, image)
                },
            };
        });
    }));
    return processedMessages;
}

export class UserConversationProcessor extends AgentOperation<UserConversationInputs, UserConversationOutputs> {
    /**
     * Remove system context tags from message content
     */
    private stripSystemContext(text: string): string {
        return text.replace(/<system_context>[\s\S]*?<\/system_context>\n?/gi, '').trim();
    }

    async execute(inputs: UserConversationInputs, options: OperationOptions): Promise<UserConversationOutputs> {
        const { env, logger, context, agent } = options;
        const { userMessage, conversationState, errors, images, projectUpdates } = inputs;
        logger.info("Processing user message", { 
            messageLength: inputs.userMessage.length,
            hasImages: !!images && images.length > 0,
            imageCount: images?.length || 0
        });

        try {
            const systemPromptMessages = getSystemPromptWithProjectContext(SYSTEM_PROMPT, context, CodeSerializerType.SIMPLE);
            
            // Create user message with optional images for inference
            const userPromptForInference = buildUserMessageWithContext(userMessage, errors, projectUpdates, true);
            const userMessageForInference = images && images.length > 0
                ? createMultiModalUserMessage(
                    userPromptForInference,
                    await imagesToBase64(env, images),
                    'high'
                )
                : createUserMessage(userPromptForInference);

            let extractedUserResponse = "";
            
            // Generate unique conversation ID for this turn
            const aiConversationId = IdGenerator.generateConversationId();

            logger.info("Generated conversation ID", { aiConversationId });

            const toolCallRenderer = buildToolCallRenderer(inputs.conversationResponseCallback, aiConversationId);
            
            // Assemble all tools with lifecycle callbacks for UI updates
            const tools = buildTools(agent, logger).map(td => ({
                ...td,
                onStart: (args: Record<string, unknown>) => toolCallRenderer({ name: td.function.name, status: 'start', args }),
                onComplete: (args: Record<string, unknown>, _result: unknown) => toolCallRenderer({ name: td.function.name, status: 'success', args })
            }));

            const runningHistory = await prepareMessagesForInference(env, conversationState.runningHistory);

            const compactHistory = await this.compactifyContext(runningHistory, env, options, toolCallRenderer, logger);
            if (compactHistory.length !== runningHistory.length) {
                logger.info("Conversation history compactified", { 
                    fullHistoryLength: conversationState.fullHistory.length,
                    runningHistoryLength: conversationState.runningHistory.length,
                    compactifiedRunningHistoryLength: compactHistory.length,
                    reduction: conversationState.runningHistory.length - compactHistory.length
                });
            }

            const messagesForInference =  [...systemPromptMessages, ...compactHistory, {...userMessageForInference, conversationId: IdGenerator.generateConversationId()}];


            logger.info("Executing inference for user message", { 
                messageLength: userMessage.length,
                aiConversationId,
                tools,
            });
            
            // Don't save the system prompts so that every time new initial prompts can be generated with latest project context
            // Use inference message (with images) for AI, but store text-only in history
            const result = await executeInference({
                env: env,
                messages: messagesForInference,
                agentActionName: "conversationalResponse",
                context: options.inferenceContext,
                tools, // Enable tools for the conversational AI
                stream: {
                    onChunk: (chunk) => {
                        logger.info("Processing user message chunk", { chunkLength: chunk.length, aiConversationId });
                        inputs.conversationResponseCallback(chunk, aiConversationId, true);
                        extractedUserResponse += chunk;
                    },
                    chunk_size: CHUNK_SIZE
                }
            });

            
            logger.info("Successfully processed user message", {
                streamingSuccess: !!extractedUserResponse,
            });

            const conversationResponse: ConversationalResponseType = {
                userResponse: extractedUserResponse
            };

            
            // For conversation history, store only text (images are ephemeral and not persisted)
            const userPromptForHistory = buildUserMessageWithContext(userMessage, errors, projectUpdates, false);
            const userMessageForHistory = images && images.length > 0
                ? createMultiModalUserMessage(
                    userPromptForHistory,
                    images.map(img => img.r2Key),
                    'high'
                )
                : createUserMessage(userPromptForHistory);

            
            const messages = [{...userMessageForHistory, conversationId: IdGenerator.generateConversationId()}];

            // Save the assistant's response to conversation history
            // If tools were called, include the tool call messages from toolCallContext
            if (result.toolCallContext?.messages && result.toolCallContext.messages.length > 0) {
                messages.push(
                    ...result.toolCallContext.messages
                        .filter((message) => !(message.role === 'assistant' && typeof(message.content) === 'string' && message.content.includes('Internal Memo')))
                        .map((message) => ({ ...message, conversationId: IdGenerator.generateConversationId() }))
                );
            }
            messages.push({...createAssistantMessage(result.string), conversationId: IdGenerator.generateConversationId()});

            // Derive compacted running history for storage using stable IDs (no re-compaction)
            const originalRunning = conversationState.runningHistory;
            let storageRunning = originalRunning;
            if (compactHistory.length !== runningHistory.length) {
                const summaryMessage = compactHistory[0]; // assistant text-only summary
                const originalById = new Map(originalRunning.map(m => [m.conversationId, m] as const));
                const preservedTail = compactHistory
                    .slice(1)
                    .map(m => originalById.get(m.conversationId))
                    .filter((m): m is ConversationMessage => !!m);
                storageRunning = [summaryMessage, ...preservedTail];
            }

            return {
                conversationResponse,
                conversationState: {
                    ...conversationState,
                    runningHistory: [...storageRunning, ...messages],
                    fullHistory: [...conversationState.fullHistory, ...messages]
                }
            };
        } catch (error) {
            logger.error("Error processing user message:", error);
            if (error instanceof RateLimitExceededError || error instanceof SecurityError) {
                throw error;
            }   

            const fallbackMessages = [
                {...createUserMessage(userMessage), conversationId: IdGenerator.generateConversationId()},
                {...createAssistantMessage(FALLBACK_USER_RESPONSE), conversationId: IdGenerator.generateConversationId()}
            ]
            
            // Fallback response
            return {
                conversationResponse: {
                    userResponse: FALLBACK_USER_RESPONSE
                },
                conversationState: {
                    ...conversationState,
                    runningHistory: [...conversationState.runningHistory, ...fallbackMessages],
                    fullHistory: [...conversationState.fullHistory, ...fallbackMessages]
                }
            };
        }
    }

    /**
     * Count conversation turns (user message to next user message)
     */
    private countTurns(messages: ConversationMessage[]): number {
        return messages.filter(m => m.role === 'user').length;
    }

    /**
     * Convert character count to estimated token count
     */
    private tokensFromChars(chars: number): number {
        return Math.ceil(chars / COMPACTIFICATION_CONFIG.CHARS_PER_TOKEN);
    }

    /**
     * Estimate token count for messages (4 chars ≈ 1 token)
     */
    private estimateTokens(messages: ConversationMessage[]): number {
        let totalChars = 0;
        
        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                totalChars += msg.content.length;
            } else if (Array.isArray(msg.content)) {
                // Multi-modal content
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        totalChars += part.text.length;
                    } else if (part.type === 'image_url') {
                        // Images use ~1000 tokens each (approximate)
                        totalChars += 4000;
                    }
                }
            }
            
            // Account for tool calls
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls as ChatCompletionMessageFunctionToolCall[]) {
                    // Function name
                    if (tc.function?.name) {
                        totalChars += tc.function.name.length;
                    }
                    // Function arguments (JSON string)
                    if (tc.function?.arguments) {
                        totalChars += tc.function.arguments.length;
                    }
                    // Tool call structure overhead (id, type, etc.) - rough estimate
                    totalChars += 50;
                }
            }
        }
        
        return this.tokensFromChars(totalChars);
    }

    /**
     * Check if compactification should be triggered
     */
    private shouldCompactify(messages: ConversationMessage[]): {
        should: boolean;
        reason?: 'turns' | 'tokens';
        turns: number;
        estimatedTokens: number;
    } {
        const turns = this.countTurns(messages);
        const estimatedTokens = this.estimateTokens(messages);
        
        if (turns >= COMPACTIFICATION_CONFIG.MAX_TURNS) {
            return { should: true, reason: 'turns', turns, estimatedTokens };
        }
        
        if (estimatedTokens >= COMPACTIFICATION_CONFIG.MAX_ESTIMATED_TOKENS) {
            return { should: true, reason: 'tokens', turns, estimatedTokens };
        }
        
        return { should: false, turns, estimatedTokens };
    }

    /**
     * Find the last valid turn boundary before the preserve threshold
     * A turn boundary is right before a user message
     */
    private findTurnBoundary(messages: ConversationMessage[], preserveCount: number): number {
        // Start from the point where we want to split
        const targetSplitIndex = messages.length - preserveCount;
        
        if (targetSplitIndex <= 0) {
            return 0;
        }
        
        // Walk backwards to find the nearest user message boundary
        for (let i = targetSplitIndex; i >= 0; i--) {
            if (messages[i].role === 'user') {
                // Split right before this user message to preserve turn integrity
                return i;
            }
        }
        
        // If no user message found, don't split
        return 0;
    }

    /**
     * Generate LLM-powered conversation summary
     * Sends the full conversation history as-is to the LLM with a summarization instruction
     */
    private async generateConversationSummary(
        messages: ConversationMessage[],
        env: Env,
        options: OperationOptions,
        logger: StructuredLogger
    ): Promise<string> {
        try {
            // Prepare summarization instruction
            const summarizationInstruction = createUserMessage(
                `Please provide a comprehensive summary of the entire conversation above. Your summary should:

1. Capture the key features, changes, and fixes discussed
2. Note any recurring issues or important bugs mentioned
3. Highlight the current state of the project
4. Preserve critical technical details and decisions made
5. Maintain chronological flow of major changes and developments

Format your summary as a cohesive, well-structured narrative. Focus on what matters for understanding the project's evolution and current state.

Provide the summary now:`
            );

            logger.info('Generating conversation summary via LLM', {
                messageCount: messages.length,
                estimatedInputTokens: this.estimateTokens(messages)
            });

            // Send full conversation history + summarization request
            const summaryResult = await executeInference({
                env,
                messages: [...messages, summarizationInstruction],
                agentActionName: 'conversationalResponse',
                context: options.inferenceContext,
            });

            const summary = summaryResult.string.trim();
            
            logger.info('Generated conversation summary', {
                summaryLength: summary.length,
                summaryTokens: this.tokensFromChars(summary.length)
            });

            return summary;
        } catch (error) {
            logger.error('Failed to generate conversation summary', { error });
            // Fallback to simple concatenation
            return messages
                .map(m => {
                    const content = typeof m.content === 'string' ? m.content : '[complex content]';
                    return `${m.role}: ${this.stripSystemContext(content).substring(0, 200)}`;
                })
                .join('\n')
                .substring(0, 2000);
        }
    }

    /**
     * Intelligent conversation compactification system
     * 
     * Strategy:
     * - Monitors turns (user message to user message) and token count
     * - Triggers at 50 turns OR ~100k tokens
     * - Uses LLM to generate intelligent summary
     * - Preserves last 10 messages in full
     * - Respects turn boundaries to avoid tool call fragmentation
     */
    async compactifyContext(
        runningHistory: ConversationMessage[],
        env: Env,
        options: OperationOptions,
        toolCallRenderer: RenderToolCall,
        logger: StructuredLogger
    ): Promise<ConversationMessage[]> {
        try {
            // Check if compactification is needed on the running history
            const analysis = this.shouldCompactify(runningHistory);
            
            if (!analysis.should) {
                // No compactification needed
                return runningHistory;
            }
            
            logger.info('Compactification triggered', {
                reason: analysis.reason,
                turns: analysis.turns,
                estimatedTokens: analysis.estimatedTokens,
                totalRunningMessages: runningHistory.length,
            });

            // Currently compactification would be done on the running history, but should we consider doing it on the full history?
            
            // Find turn boundary for splitting
            const splitIndex = this.findTurnBoundary(
                runningHistory,
                COMPACTIFICATION_CONFIG.PRESERVE_RECENT_MESSAGES
            );
            
            // Safety check: ensure we have something to compactify
            if (splitIndex <= 0) {
                logger.warn('Cannot find valid turn boundary for compactification, preserving all messages');
                return runningHistory;
            }
            
            // Split messages
            const messagesToSummarize = runningHistory.slice(0, splitIndex);
            const recentMessages = runningHistory.slice(splitIndex);
            
            logger.info('Compactification split determined', {
                summarizeCount: messagesToSummarize.length,
                preserveCount: recentMessages.length,
                splitIndex
            });
            
            toolCallRenderer({ 
                name: 'summarize_history', 
                status: 'start', 
                args: { 
                    messageCount: messagesToSummarize.length,
                    recentCount: recentMessages.length 
                } 
            });

            // Generate LLM-powered summary
            const summary = await this.generateConversationSummary(
                messagesToSummarize,
                env,
                options,
                logger
            );

            // Create summary message - its conversationId will be the archive ID
            const summarizedTurns = this.countTurns(messagesToSummarize);
            const archiveId = `archive-${Date.now()}-${IdGenerator.generateConversationId()}`;
            
            const summaryMessage: ConversationMessage = {
                role: 'assistant' as MessageRole,
                content: `[Conversation History Summary: ${messagesToSummarize.length} messages, ${summarizedTurns} turns]\n[Archive ID: ${archiveId}]\n\n${summary}`,
                conversationId: archiveId
            };
            
            toolCallRenderer({ 
                name: 'summarize_history', 
                status: 'success', 
                args: { 
                    summary: summary.substring(0, 200) + '...',
                    archiveId 
                } 
            });
            
            // Return summary + recent messages
            const compactifiedHistory = [summaryMessage, ...recentMessages];
            
            logger.info('Compactification completed with archival', {
                originalMessageCount: runningHistory.length,
                newMessageCount: compactifiedHistory.length,
                compressionRatio: (compactifiedHistory.length / runningHistory.length).toFixed(2),
                estimatedTokenSavings: analysis.estimatedTokens - this.estimateTokens(compactifiedHistory),
                archivedMessageCount: messagesToSummarize.length,
                archiveId
            });
            
            return compactifiedHistory;
            
        } catch (error) {
            logger.error('Compactification failed, preserving original messages', { error });
            
            // Safe fallback: if we have too many messages, keep recent ones
            if (runningHistory.length > COMPACTIFICATION_CONFIG.PRESERVE_RECENT_MESSAGES * 3) {
                const fallbackCount = COMPACTIFICATION_CONFIG.PRESERVE_RECENT_MESSAGES * 2;
                logger.warn(`Applying emergency fallback: keeping last ${fallbackCount} messages`);
                return runningHistory.slice(-fallbackCount);
            }

            return runningHistory;
        }
    }


    processProjectUpdates<T extends ProjectUpdateType>(updateType: T, _data: WebSocketMessageData<T>, logger: StructuredLogger) : ConversationMessage[] {
        try {
            logger.info("Processing project update", { updateType });

            // Just save it as an assistant message. Dont save data for now to avoid DO size issues
            const preparedMessage = `**<Internal Memo>**
Project Updates: ${updateType}
</Internal Memo>`;

            return [{
                role: 'assistant',
                content: preparedMessage,
                conversationId: IdGenerator.generateConversationId()
            }];
        } catch (error) {
            logger.error("Error processing project update:", error);
            return [];
        }
    }

    isProjectUpdateType(type: unknown): type is ProjectUpdateType {
        return RelevantProjectUpdateWebsoketMessages.includes(type as ProjectUpdateType);
    }
}
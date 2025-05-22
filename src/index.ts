import { createSigner,  getEncryptionKeyFromHex, validateEnvironment    ,logAgentDetails, getDbPath } from "../helpers/client";
import { Client, GroupMember, IdentifierKind, KeyPackageStatus, LogLevel, type XmtpEnv } from "@xmtp/node-sdk";
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { env } from "node:process";

const require = createRequire(import.meta.url);
// Absolute path to *that* copy of the dependency's package.json
const pkgJsonPath = require.resolve('@xmtp/node-sdk/package.json');
const { version: xmtpSdkVersion } =
  JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

console.log(`XMTP node-sdk: v${xmtpSdkVersion}`);

/* Get the wallet key associated to the public key of
 * the agent and the encryption key for the local db
 * that stores your agent's messages */
const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV } = validateEnvironment([
  "WALLET_KEY",
  "ENCRYPTION_KEY",
  "XMTP_ENV",
]);

/* Create the signer using viem and parse the encryption key for the local db */
const signer = createSigner(WALLET_KEY);
const encryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);

async function main() {
  const startTime = new Date();
  console.log(`Creating client on the '${XMTP_ENV}' network...`);
  const signerIdentifier = (await signer.getIdentifier()).identifier;
  const client = await Client.create(signer, {
    dbEncryptionKey: encryptionKey,
    dbPath: getDbPath(XMTP_ENV + "-" + signerIdentifier  ),  
    env: XMTP_ENV as XmtpEnv,
    loggingLevel: process.env.LOGGING_LEVEL as LogLevel,
  });

  // await client.revokeAllOtherInstallations();

  logAgentDetails(client);

  console.log("✓ Syncing conversations...");
  await client.conversations.sync();

  let conversations = await client.conversations.list();

  // Print the list of conversations ids to console:
  console.log("Conversations:", conversations.map((conversation) => conversation.id));

  console.log("Waiting for messages...");
  try {
    const stream = await client.conversations.streamAllMessages();

  for await (const message of stream) {
    if (
      message?.senderInboxId.toLowerCase() === client.inboxId.toLowerCase() ||
      message?.contentType?.typeId !== "text"
    ) {
      console.log("Skipping message, from us or not text");
      continue;
    }

    const conversation = await client.conversations.getConversationById(
      message.conversationId,
    );

    if (!conversation) {
      console.log("Unable to find conversation, skipping");
      continue;
    }

    // Get the message content
    const content = message.content as string;
    
    // Only process messages that start with "/key-check"
    if (!content.trim().startsWith("/key-check") && !content.trim().startsWith("/kc")) {
      continue;
    }

    console.log(`Received command: ${content}`);
    
    // Parse the command
    const parts = content.trim().split(/\s+/);
    const prefix = parts[0].toLowerCase();
    const command = parts.length > 1 ? parts[1] : "";
    
    if (command === "help") {
      // Send help information
      const helpText = 
        "Available commands:\n" +
        "/key-check - Check key package status for the sender\n" +
        "/key-check inboxid <INBOX_ID> - Check key package status for a specific inbox ID\n" +
        "/key-check address <ADDRESS> - Check key package status for a specific address\n" +
        "/key-check groupid - Show the current conversation ID\n" +
        "/key-check members - List all members' inbox IDs in the current conversation\n" +
        "/key-check version - Show XMTP SDK version information\n" +
        "/key-check uptime - Show when the bot started and how long it has been running\n" +
        "/key-check debug - Show debug information for the key-check bot\n" +
        "/key-check help - Show this help message\n" +
        "Note: You can use /kc as a shorthand for all commands (e.g., /kc help)";

      await conversation.send(helpText);
      console.log("Sent help information");
      continue;
    }
    
    // Handle groupid command
    if (command === "groupid") {
      await conversation.send(`Conversation ID: "${message.conversationId}"`);
      console.log(`Sent conversation ID: ${message.conversationId}`);
      continue;
    }

    // Handle version command
    if (command === "version") {
      await conversation.send(`XMTP node-sdk Version: ${xmtpSdkVersion}`);
      console.log(`Sent XMTP node-sdk version: ${xmtpSdkVersion}`);
      continue;
    }

    // Handle uptime command
    if (command === "uptime") {
      const currentTime = new Date();
      const uptimeMs = currentTime.getTime() - startTime.getTime();
      
      // Convert milliseconds to days, hours, minutes, seconds
      const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
      const hours = Math.floor((uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((uptimeMs % (1000 * 60)) / 1000);
      
      const uptimeText = `Bot started at: ${startTime.toLocaleString()}\n` +
        `Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s`;
      
      await conversation.send(uptimeText);
      console.log(`Sent uptime information: ${uptimeText}`);
      continue;
    }

    // Handle debug command
    if (command === "debug") {
      let conversations = await client.conversations.list();
      // Print the list of conversations ids to console:
      console.log("Conversations:", conversations.map((conversation) => conversation.id));
      await conversation.send(`key-check conversations: \n${conversations.map((conversation) => conversation.id).join('\n')}`);
      continue;
    }

    // Handle members command
    if (command === "members") {
      const members: GroupMember[] = await conversation.members();
      
      if (!members || members.length === 0) {
        await conversation.send("No members found in this conversation.");
        console.log("No members found in the conversation");
        continue;
      }
      
      let membersList = "Group members:\n\n";
      
      for (const member of members) {
        const isBot = member.inboxId.toLowerCase() === client.inboxId.toLowerCase();
        let marker = isBot ? "~" : " ";
        const isSender = member.inboxId.toLowerCase() === message.senderInboxId.toLowerCase();
        marker = isSender ? "*" : marker;
        membersList += `${marker}${member.inboxId}${marker}\n\n`;
      }
      
      membersList += "\n ~indicates key-check bot's inbox ID~";
      membersList += "\n *indicates who prompted the key-check command*";
      
      await conversation.send(membersList);
      console.log(`Sent list of ${members.length} members`);
      continue;
    }
    
    let targetInboxId = message.senderInboxId;
    let targetAddress = "";
    
    // Handle specific inbox ID or address lookup
    if (command === "inboxid" && parts.length > 2) {
      targetInboxId = parts[2];
      console.log(`Looking up inbox ID: ${targetInboxId}`);
    } else if (command === "address" && parts.length > 2) {
      targetAddress = parts[2];
      console.log(`Looking up address: ${targetAddress}`);
      
      // Need to find the inbox ID for this address
      try {
        const inboxId = await client.getInboxIdByIdentifier({identifier: targetAddress, identifierKind: IdentifierKind.Ethereum});
        if (!inboxId) {
          await conversation.send(`No inbox found for address ${targetAddress}`);
          continue;
        }
        targetInboxId = inboxId;
      } catch (error) {
        console.error(`Error resolving address ${targetAddress}:`, error);
        await conversation.send(`Error resolving address ${targetAddress}`);
        continue;
      }
    }
    
    // Get inbox state for the target inbox ID
    try {
      const inboxState = await client.preferences.inboxStateFromInboxIds([
        targetInboxId,
      ], true);
      
      if (!inboxState || inboxState.length === 0) {
        await conversation.send(`No inbox state found for ${targetInboxId}`);
        continue;
      }
      
      const addressFromInboxId = inboxState[0].identifiers[0].identifier;

      // Retrieve all the installation ids for the target
      const installationIds = inboxState[0].installations.map(
        (installation) => installation.id,
      );

      // Retrieve a map of installation id to KeyPackageStatus
      const status: Record<string, KeyPackageStatus | undefined> =
        await client.getKeyPackageStatusesForInstallationIds(installationIds);
      console.log(status);

      // Count valid and invalid installations
      const totalInstallations = Object.keys(status).length;
      const validInstallations = Object.values(status).filter(
        (value) => !value?.validationError
      ).length;
      const invalidInstallations = totalInstallations - validInstallations;

      // Create and send a human-readable summary with abbreviated IDs
      let summaryText = `InboxID: \n"${targetInboxId}" \nAddress: \n"${addressFromInboxId}" \n You have ${totalInstallations} installations, ${validInstallations} of them are valid and ${invalidInstallations} of them are invalid.\n\n`;
      for (const [installationId, installationStatus] of Object.entries(status)) {
        // Abbreviate the installation ID (first 4 and last 4 characters)
        const shortId = installationId.length > 8 
          ? `${installationId.substring(0, 4)}...${installationId.substring(installationId.length - 4)}`
          : installationId;
          
        if (installationStatus?.lifetime) {
          const createdDate = new Date(
            Number(installationStatus.lifetime.notBefore) * 1000,
          );
          const expiryDate = new Date(
            Number(installationStatus.lifetime.notAfter) * 1000,
          );
          
          summaryText += `✅ '${shortId}':\n`;
          summaryText += `- created: ${createdDate.toLocaleString()}\n`;
          summaryText += `- valid until: ${expiryDate.toLocaleString()}\n\n`;
        } else if (installationStatus?.validationError) {
          summaryText += `❌ '${shortId}':\n`;
          summaryText += `- validationError: '${installationStatus.validationError}'\n\n`;
        }
      }
      
      await conversation.send(summaryText);
      console.log(`Sent key status for ${targetInboxId}`);
    } catch (error) {
      console.error(`Error processing key-check for ${targetInboxId}:`, error);
      await conversation.send(`Error processing key-check: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    console.log("Waiting for messages...");
  }
} catch (error) {
    console.error("Error streaming messages:", error);
  }
}

main().catch(console.error);

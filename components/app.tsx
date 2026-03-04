"use client";

import Controls from "@/components/controls";
import Scene from "@/components/scene";
import Logs from "@/components/logs";
import { useEffect, useRef, useState, useCallback } from "react";
import { INSTRUCTIONS, TOOLS } from "@/lib/config";
import { REALTIME_CALLS_URL } from "@/lib/constants";

type ToolCallOutput = {
  response: string;
  [key: string]: any;
};

type RealtimeClientSecret = {
  value: string;
  expires_at: number;
  session?: {
    id?: string;
  };
};

export default function App() {
  const [logs, setLogs] = useState<any[]>([]);
  const [toolCall, setToolCall] = useState<any>(null);
  const [isSessionStarted, setIsSessionStarted] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const audioTransceiver = useRef<RTCRtpTransceiver | null>(null);
  const tracks = useRef<RTCRtpSender[] | null>(null);

  // Start a new realtime session
  async function startSession() {
    let pc: RTCPeerConnection | null = null;
    let stream: MediaStream | null = null;

    try {
      if (!isSessionStarted) {
        setIsSessionStarted(true);

        const sessionResponse = await fetch("/api/session");
        if (!sessionResponse.ok) {
          throw new Error(await sessionResponse.text());
        }

        const session: RealtimeClientSecret = await sessionResponse.json();
        const sessionToken = session.value;
        const sessionId = session.session?.id;

        if (!sessionToken) {
          throw new Error("Realtime client secret is missing from /api/session");
        }

        if (sessionId) {
          console.log("Session id:", sessionId);
        }

        // Create a peer connection
        pc = new RTCPeerConnection();
        const activePeerConnection = pc;

        // Set up to play remote audio from the model
        if (!audioElement.current) {
          audioElement.current = document.createElement("audio");
        }
        audioElement.current.autoplay = true;
        activePeerConnection.ontrack = (e) => {
          if (audioElement.current) {
            audioElement.current.srcObject = e.streams[0];
          }
        };

        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const activeStream = stream;
        setAudioStream(activeStream);

        activeStream.getTracks().forEach((track) => {
          const sender = activePeerConnection.addTrack(track, activeStream);
          if (sender) {
            tracks.current = [...(tracks.current || []), sender];
          }
        });

        // Set up data channel for sending and receiving events
        const dc = activePeerConnection.createDataChannel("oai-events");
        setDataChannel(dc);

        // Start the session using the Session Description Protocol (SDP)
        const offer = await activePeerConnection.createOffer();
        await activePeerConnection.setLocalDescription(offer);

        const sdpResponse = await fetch(REALTIME_CALLS_URL, {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${sessionToken}`,
            "Content-Type": "application/sdp",
          },
        });

        if (!sdpResponse.ok) {
          throw new Error(await sdpResponse.text());
        }

        const answer: RTCSessionDescriptionInit = {
          type: "answer",
          sdp: await sdpResponse.text(),
        };
        await activePeerConnection.setRemoteDescription(answer);

        peerConnection.current = activePeerConnection;
      }
    } catch (error) {
      console.error("Error starting session:", error);
      stream?.getTracks().forEach((track) => track.stop());
      pc?.close();
      tracks.current = null;
      setAudioStream(null);
      setDataChannel(null);
      setIsSessionStarted(false);
      setIsSessionActive(false);
      setIsListening(false);
    }
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
    }
    if (peerConnection.current) {
      peerConnection.current.close();
    }

    setIsSessionStarted(false);
    setIsSessionActive(false);
    setDataChannel(null);
    setToolCall(null);
    peerConnection.current = null;
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
    }
    setAudioStream(null);
    setIsListening(false);
    audioTransceiver.current = null;
    tracks.current = null;
    if (audioElement.current) {
      audioElement.current.srcObject = null;
    }
  }

  // Grabs a new mic track and replaces the placeholder track in the transceiver
  async function startRecording() {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      setAudioStream(newStream);

      // If we already have an audioSender, just replace its track:
      if (tracks.current) {
        const micTrack = newStream.getAudioTracks()[0];
        tracks.current.forEach((sender) => {
          sender.replaceTrack(micTrack);
        });
      } else if (peerConnection.current) {
        // Fallback if audioSender somehow didn't get set
        newStream.getTracks().forEach((track) => {
          const sender = peerConnection.current?.addTrack(track, newStream);
          if (sender) {
            tracks.current = [...(tracks.current || []), sender];
          }
        });
      }

      setIsListening(true);
      console.log("Microphone started.");
    } catch (error) {
      console.error("Error accessing microphone:", error);
    }
  }

  // Replaces the mic track with a placeholder track
  function stopRecording() {
    setIsListening(false);

    // Stop existing mic tracks so the user’s mic is off
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
    }
    setAudioStream(null);

    // Replace with a placeholder (silent) track
    if (tracks.current) {
      const placeholderTrack = createEmptyAudioTrack();
      tracks.current.forEach((sender) => {
        sender.replaceTrack(placeholderTrack);
      });
    }
  }

  // Creates a placeholder track that is silent
  function createEmptyAudioTrack(): MediaStreamTrack {
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    return destination.stream.getAudioTracks()[0];
  }

  // Send a message to the model
  const sendClientEvent = useCallback(
    (message: any) => {
      if (dataChannel?.readyState === "open") {
        message.event_id = message.event_id || crypto.randomUUID();
        dataChannel.send(JSON.stringify(message));
      } else {
        console.error(
          "Failed to send message - no data channel available",
          message
        );
      }
    },
    [dataChannel]
  );

  // Attach event listeners to the data channel when a new one is created
  useEffect(() => {
    async function handleToolCall(output: any) {
      const toolCall = {
        name: output.name,
        arguments: output.arguments,
      };
      console.log("Tool call:", toolCall);
      setToolCall(toolCall);

      // TOOL CALL HANDLING
      // Initialize toolCallOutput with a default response
      const toolCallOutput: ToolCallOutput = {
        response: `Tool call ${toolCall.name} executed successfully.`,
      };

      // Handle special tool calls
      if (toolCall.name === "get_iss_position") {
        const issPosition = await fetch("/api/iss").then((response) =>
          response.json()
        );
        console.log("ISS position:", issPosition);
        toolCallOutput.issPosition = issPosition;
      }

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: output.call_id,
          output: JSON.stringify(toolCallOutput),
        },
      });

      // Force a model response to make sure it responds after certain tool calls
      if (
        toolCall.name === "get_iss_position" ||
        toolCall.name === "display_data"
      ) {
        sendClientEvent({
          type: "response.create",
        });
      }
    }

    if (dataChannel) {
      const handleMessage = (e: MessageEvent) => {
        const event = JSON.parse(e.data);

        if (event.type === "error") {
          console.error("Realtime error:", event);
          setLogs((prev) => [event, ...prev]);
          return;
        }

        if (event.type === "response.done") {
          const outputs = event.response?.output ?? [];
          const functionCall = outputs.find(
            (output: any) => output?.type === "function_call"
          );

          if (outputs.length > 0) {
            setLogs((prev) => [...outputs, ...prev]);
          }

          if (functionCall) {
            void handleToolCall(functionCall);
          }
        }
      };

      const handleOpen = () => {
        setIsSessionActive(true);
        setIsListening(true);
        setLogs([]);

        const sessionUpdate = {
          type: "session.update",
          session: {
            type: "realtime",
            tools: TOOLS,
            instructions: INSTRUCTIONS,
          },
        };

        sendClientEvent(sessionUpdate);
        console.log("Session update sent:", sessionUpdate);
      };

      // Append new server events to the list
      dataChannel.addEventListener("message", handleMessage);

      // Set session active when the data channel is opened
      dataChannel.addEventListener("open", handleOpen);

      return () => {
        dataChannel.removeEventListener("message", handleMessage);
        dataChannel.removeEventListener("open", handleOpen);
      };
    }
  }, [dataChannel, sendClientEvent]);

  const handleConnectClick = async () => {
    if (isSessionActive) {
      console.log("Stopping session.");
      stopSession();
    } else {
      console.log("Starting session.");
      startSession();
    }
  };

  const handleMicToggleClick = async () => {
    if (!isSessionActive) return;

    if (isListening) {
      console.log("Stopping microphone.");
      stopRecording();
    } else {
      console.log("Starting microphone.");
      startRecording();
    }
  };

  return (
    <div className="relative size-full">
      <Scene toolCall={toolCall} />
      <Controls
        handleConnectClick={handleConnectClick}
        handleMicToggleClick={handleMicToggleClick}
        isConnected={isSessionActive}
        isListening={isListening}
      />
      <Logs messages={logs} />
    </div>
  );
}

import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Phone, Video, X, Mic, MicOff, VideoOff, Lock, PhoneMissed, LogOut, Image as ImageIcon } from 'lucide-react';
import { cn } from './lib/utils';

// Socket connection
// In production, VITE_SERVER_URL must be set to your backend URL (e.g., https://ourspace-backend.onrender.com)
// Helper to determine the server URL dynamically
const getBaseUrl = () => {
  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;
  
  if (import.meta.env.PROD) {
    console.warn("VITE_SERVER_URL is not set in production. Using current origin.");
    return window.location.origin; // If hosted together in production
  }
  
  // Fallback for local development
  return `${window.location.protocol}//${window.location.hostname}:3001`;
};

const socket = io(getBaseUrl());

type Message = {
  id: number;
  content: string;
  sender: string;
  type: string;
  createdAt: string;
};

// ICE Server configuration (free STUN servers)
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ],
};

const PASSKEY = '2828';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passkeyInput, setPasskeyInput] = useState('');
  const [userChange, setUserChange] = useState('');
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Call State
  const [isCalling, setIsCalling] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'receiving' | 'connected'>('idle');
  const [callType, setCallType] = useState<'audio' | 'video'>('video');
  const [incomingCall, setIncomingCall] = useState<{ from: string, signal: any, type?: 'audio' | 'video' } | null>(null);
  const [isMyVideoEnabled, setIsMyVideoEnabled] = useState(true);
  const [isMyMicEnabled, setIsMyMicEnabled] = useState(true);
  const [partnerStatus, setPartnerStatus] = useState<{ online: boolean; lastSeen: string | null }>({ online: false, lastSeen: null });

  /* Local Video - PiP (Only for Video Calls) */
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ... (Refs)
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);

  // Helper to normalize names
  const normalizeName = (name: string) => {
    const n = name.toLowerCase().trim();
    if (n === 'tulsi') return 'tulu';
    return n;
  };

  const getPartnerName = (name: string) => {
    const n = normalizeName(name);
    if (n === 'abhi') return 'Tulu';
    if (n === 'tulu') return 'Abhi';
    return 'Partner';
  };
  const partnerName = getPartnerName(userChange);

  useEffect(() => {
    const savedAuth = sessionStorage.getItem('ourspace_auth');
    const savedUser = sessionStorage.getItem('ourspace_user');
    if (savedAuth === 'true' && savedUser) {
      setIsAuthenticated(true);
      setUserChange(savedUser);
      socket.emit('user_login', savedUser); // Notify server we are back
    }

    // Join Global Room for signaling
    socket.emit('join_room', 'ourspace_global');

    // Handle Reconnection
    const onConnect = () => {
      console.log("Connected/Reconnected to server");
      setIsConnected(true);
      if (sessionStorage.getItem('ourspace_user')) {
        socket.emit('user_login', sessionStorage.getItem('ourspace_user'));
      }
    };

    socket.on('connect', onConnect);

    // If already connected, manual trigger
    if (socket.connected) {
      onConnect();
    }

    socket.on('disconnect', () => {
      console.log("Disconnected from server");
      setIsConnected(false);
    });

    socket.on('connect_error', (err: any) => {
      console.error("Connection Error:", err);
      setIsConnected(false);
    });

    socket.on('receive_message', (data: Message) => {
      setMessages((prev) => [...prev, data]);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    });

    // Status Updates
    socket.on('user_status_update', ({ username, status }) => {
      const currentPartner = getPartnerName(savedUser || userChange);
      // If the update is about our partner
      if (normalizeName(username) === normalizeName(currentPartner)) {
        setPartnerStatus(status);
      }
    });

    socket.on('all_users_status', (users) => {
      const currentPartner = getPartnerName(savedUser || userChange);
      // Find partner in the list
      const pName = Object.keys(users).find(u => normalizeName(u) === normalizeName(currentPartner));
      if (pName) {
        setPartnerStatus(users[pName]);
      }
    });

    // ... (rest of WebRTC listeners)
    socket.on('call_incoming', async (data) => {
      console.log("### RECEIVED INCOMING CALL ###", data);
      setIncomingCall(data);
      // Determine call type from signal or data if available, defaulting to video for now unless specified
      setCallType(data.type || 'video');
      setCallStatus('receiving');
      setIsCalling(true);
    });

    socket.on('call_answered', async (data) => {
      console.log("Call answered");
      if (peerConnection.current) {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.signal));
        setCallStatus('connected');
      }
    });

    socket.on('ice_candidate', async (data) => {
      if (peerConnection.current && data.candidate) {
        try {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error("Error adding ice candidate", e);
        }
      }
    });

    socket.on('call_ended', () => {
      endCallCleanup();
    });

    // Fetch initial history
    const apiUrl = `${getBaseUrl()}/api/messages`;
    console.log("Fetching messages from:", apiUrl);
    fetch(apiUrl)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json();
      })
      .then(data => {
        console.log("Messages fetched:", data.length);
        setMessages(data);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 500);
      })
      .catch(err => {
        console.error("Failed to fetch messages:", err);
        alert(`Failed to load message history from ${apiUrl}. Check console for details.`);
      });

    socket.on('message_error', (errMsg) => {
      alert(errMsg);
    });

    return () => {
      socket.off('receive_message');
      socket.off('message_error');
      socket.off('call_incoming');
      socket.off('call_answered');
      socket.off('ice_candidate');
      socket.off('call_ended');
      socket.off('user_status_update');
      socket.off('all_users_status');
    };
  }, [userChange]); // Re-run if userChange changes to subscribe correctly

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (passkeyInput === PASSKEY) {
      setIsAuthenticated(true);
      sessionStorage.setItem('ourspace_auth', 'true');
      sessionStorage.setItem('ourspace_user', userChange);
      socket.emit('user_login', userChange);
    } else {
      alert("Wrong passkey, my love.");
    }
  };

  const handleLogout = () => {
    socket.emit('user_logout');
    sessionStorage.removeItem('ourspace_auth');
    sessionStorage.removeItem('ourspace_user');
    setIsAuthenticated(false);
    setUserChange('');
    setMessages([]);
    setPasskeyInput('');
  };

  const endCallCleanup = () => {
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
      localStream.current = null;
    }
    setIsCalling(false);
    setCallStatus('idle');
    setIncomingCall(null);
    setIsMyVideoEnabled(true);
    setIsMyMicEnabled(true);
  };

  const toggleVideo = () => {
    if (localStream.current) {
      const videoTrack = localStream.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsMyVideoEnabled(videoTrack.enabled);
      }
    }
  };

  const toggleMic = () => {
    if (localStream.current) {
      const audioTrack = localStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMyMicEnabled(audioTrack.enabled);
      }
    }
  };

  const processFile = (file: File) => {
    if (file.size > 1024 * 1024) { // 1MB limit for socket
      alert("Image too large! Please choose a smaller image (under 1MB).");
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewImage(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const sendImage = () => {
    if (!previewImage) return;
    const data = {
      content: previewImage,
      sender: userChange || 'Anonymous',
      type: 'image'
    };
    socket.emit('send_message', data);
    setPreviewImage(null);
  };

  const cancelImage = () => {
    setPreviewImage(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          processFile(file);
          e.preventDefault(); // Prevent pasting the file name/binary text
        }
      }
    }
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const data = {
      content: inputText,
      sender: userChange || 'Anonymous',
      type: 'text'
    };

    socket.emit('send_message', data);
    setInputText('');
  };

  // --- WebRTC Functions ---

  const createPeerConnection = () => {
    const pc = new RTCPeerConnection(iceServers);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice_candidate', { candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection State:", pc.connectionState);
      if (pc.connectionState === 'connected') {
        setCallStatus('connected');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        alert("Call connection failed. You might be on a restrictive network.");
        endCallCleanup();
      }
    };

    return pc;
  };

  const startCall = async (isVideo: boolean) => {
    setIsCalling(true);
    setCallStatus('calling');
    setCallType(isVideo ? 'video' : 'audio');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
      localStream.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = createPeerConnection();
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      peerConnection.current = pc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('call_user', { signal: offer, from: userChange, type: isVideo ? 'video' : 'audio' });
    } catch (err) {
      console.error("Error starting call:", err);
      endCallCleanup();
    }
  };

  const answerCall = async () => {
    if (!incomingCall) return;
    setCallStatus('connected');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStream.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = createPeerConnection();
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      peerConnection.current = pc;

      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer_call', { signal: answer });
    } catch (err) {
      console.error("Error answering call:", err);
      endCallCleanup();
    }
  };

  const endCall = () => {
    if (callStatus === 'calling' || callStatus === 'receiving') {
      socket.emit('send_message', {
        content: 'Missed video call',
        sender: userChange,
        type: 'missed_call'
      });
    }
    socket.emit('end_call');
    endCallCleanup();
  };

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-zinc-900/50 backdrop-blur-xl p-8 rounded-2xl border border-white/10 shadow-2xl"
        >
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-pink-500/20 rounded-full text-pink-500">
              <Lock size={32} />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-center mb-2 bg-gradient-to-r from-pink-500 to-purple-500 bg-clip-text text-transparent">
            OurSpace
          </h1>
          <p className="text-zinc-400 text-center mb-8">Enter our secret key</p>

          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="password"
              value={passkeyInput}
              onChange={(e) => setPasskeyInput(e.target.value)}
              placeholder="Passkey"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl px-4 py-3 text-center tracking-[0.5em] text-white focus:outline-none focus:border-pink-500 transition-colors"
            />
            <input
              type="text"
              value={userChange}
              onChange={(e) => setUserChange(e.target.value)}
              placeholder="Your Name (e.g. Abhi)"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl px-4 py-3 text-center text-white focus:outline-none focus:border-purple-500 transition-colors"
            />
            <button
              type="submit"
              className="w-full bg-gradient-to-r from-pink-600 to-purple-600 text-white font-bold py-3 rounded-xl hover:opacity-90 transition-opacity"
            >
              Enter
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  // Header Replacement
  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-zinc-900/50 backdrop-blur border-b border-white/5 z-10">
        <div className="flex flex-col">
          <h2 className="text-xl font-bold bg-gradient-to-r from-pink-400 to-purple-400 bg-clip-text text-transparent">
            {partnerName}
          </h2>
          <span className="text-xs text-zinc-500 flex items-center gap-2">
            {partnerStatus.online ? (
              <span className="text-green-500 font-medium animate-pulse">Online</span>
            ) : (
              <span>OurSpace</span>
            )}
            <span className={cn("w-2 h-2 rounded-full", isConnected ? "bg-green-500" : "bg-red-500")} title={isConnected ? "Connected to Server" : "Disconnected"} />
          </span>
        </div>
        <div className="flex gap-4 items-center">
          {/* ... buttons ... */}
          <button
            onClick={() => startCall(false)}
            className="p-2 hover:bg-white/10 rounded-full transition-colors text-zinc-400 hover:text-white"
          >
            <Phone size={20} />
          </button>
          <button
            onClick={() => startCall(true)}
            className="p-2 hover:bg-white/10 rounded-full transition-colors text-zinc-400 hover:text-white"
          >
            <Video size={20} />
          </button>
          <div className="w-px h-6 bg-white/10 mx-1" />
          <button
            onClick={handleLogout}
            className="p-2 hover:bg-red-500/10 rounded-full transition-colors text-zinc-500 hover:text-red-400"
            title="Log Out"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gradient-to-b from-black to-zinc-900">
        {messages.map((msg) => {
          // Helper to normalize names for comparison
          const normalizeName = (name: string) => {
            const n = name.toLowerCase().trim();
            if (n === 'tulsi') return 'tulu';
            return n;
          };

          const isMe = normalizeName(msg.sender) === normalizeName(userChange);

          if (msg.type === 'missed_call') {
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-center my-2"
              >
                <div className="flex items-center gap-2 px-4 py-2 bg-zinc-800/50 rounded-full text-red-400 text-sm border border-red-500/20">
                  <PhoneMissed size={14} />
                  <span>{msg.content} from {msg.sender}</span>
                  <span className="text-[10px] opacity-50 ml-2">
                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </motion.div>
            );
          }

          return (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn("flex", isMe ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[80%] px-4 py-2 rounded-2xl backdrop-blur-sm",
                  isMe
                    ? "bg-purple-600/80 text-white rounded-tr-sm"
                    : "bg-zinc-800/80 text-zinc-100 rounded-tl-sm"
                )}
              >
                {!isMe && <div className="text-xs text-zinc-400 mb-1">{msg.sender}</div>}
                {msg.type === 'image' ? (
                  <img
                    src={msg.content}
                    alt="Shared photo"
                    className="max-w-[200px] max-h-[200px] w-auto h-auto rounded-lg border border-white/10 my-1 cursor-pointer hover:opacity-90 transition-opacity object-cover"
                    onClick={() => window.open(msg.content, '_blank')}
                  />
                ) : (
                  <div className="break-words">{msg.content}</div>
                )}
                <div className="text-[10px] opacity-50 text-right mt-1">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </motion.div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Image Preview Overlay */}
      <AnimatePresence>
        {previewImage && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="absolute bottom-20 left-4 right-4 md:left-1/3 md:right-1/3 z-50 p-4 bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl flex flex-col items-center"
          >
            <div className="relative w-full mb-4 rounded-xl overflow-hidden bg-black/50 aspect-video flex items-center justify-center">
              <img src={previewImage} alt="Preview" className="max-h-60 max-w-full object-contain" />
              <button
                onClick={cancelImage}
                className="absolute top-2 right-2 p-1 bg-black/50 rounded-full text-white hover:bg-red-500 transition-colors"
                title="Cancel"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex gap-2 w-full">
              <button
                onClick={cancelImage}
                className="flex-1 py-2 rounded-xl bg-zinc-800 text-zinc-300 font-medium hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={sendImage}
                className="flex-1 py-2 rounded-xl bg-purple-600 text-white font-bold hover:bg-purple-500 transition-colors flex items-center justify-center gap-2"
              >
                <Send size={16} /> Send Photo
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input Area */}
      <div className="p-4 bg-zinc-900/80 backdrop-blur border-t border-white/5 relative">
        <form onSubmit={sendMessage} className="flex gap-2 max-w-4xl mx-auto items-center">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            ref={fileInputRef}
            onChange={handleImageUpload}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-3 bg-zinc-800 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
            title="Send Image"
          >
            <ImageIcon size={20} />
          </button>

          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onPaste={handlePaste}
            placeholder="Type a message..."
            className="flex-1 bg-zinc-800 border-none rounded-full px-6 py-3 text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
          />
          <button
            type="submit"
            disabled={!inputText.trim()}
            className="p-3 bg-purple-600 rounded-full text-white disabled:opacity-50 hover:bg-purple-500 transition-colors"
          >
            <Send size={20} />
          </button>
        </form>
      </div>

      {/* Video Call Modal (Actual Implementation) */}
      <AnimatePresence>
        {isCalling && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-black/95 backdrop-blur-xl flex flex-col pt-12 pb-8 px-4"
          >
            {/* Remote Video - Full Size */}
            <div className="flex-1 relative bg-zinc-800 rounded-3xl overflow-hidden border border-white/10 shadow-2xl mb-8 flex items-center justify-center">
              {callType === 'video' ? (
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center justify-center animate-pulse">
                  <div className="w-32 h-32 rounded-full bg-gradient-to-r from-pink-500 to-purple-500 flex items-center justify-center text-4xl font-bold mb-4 shadow-lg shadow-purple-500/30">
                    {partnerName[0]?.toUpperCase()}
                  </div>
                  <h3 className="text-2xl font-bold text-white mb-2">{partnerName}</h3>
                  <p className="text-zinc-400">Audio Call...</p>
                </div>
              )}

              {/* Overlay Info */}
              <div className="absolute top-4 left-4 right-4 flex justify-between items-start z-10">
                <div className="px-4 py-2 bg-black/40 backdrop-blur-md rounded-full text-white font-medium">
                  {callStatus === 'connected' ? partnerName :
                    callStatus === 'receiving' ? `${partnerName} calling...` :
                      'Calling...'}
                </div>

                {/* Local Video - PiP (Only for Video Calls) */}
                {callType === 'video' && (
                  <div className="w-32 sm:w-48 aspect-[3/4] bg-zinc-900 rounded-xl border border-white/20 shadow-lg overflow-hidden">
                    <video
                      ref={localVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover mirror"
                    />
                  </div>
                )}
              </div>


              {/* Call Actions */}
              <div className="absolute bottom-8 left-0 right-0 flex justify-center gap-8">
                {callStatus === 'receiving' ? (
                  <>
                    <button
                      onClick={answerCall}
                      className="p-6 bg-green-500 rounded-full text-white hover:bg-green-600 shadow-xl shadow-green-500/20 animate-pulse"
                    >
                      <Phone size={32} />
                    </button>
                    <button
                      onClick={endCall}
                      className="p-6 bg-red-500 rounded-full text-white hover:bg-red-600 shadow-xl shadow-red-500/20"
                    >
                      <X size={32} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={toggleMic}
                      className={cn(
                        "p-4 backdrop-blur rounded-full transition-colors",
                        isMyMicEnabled ? "bg-zinc-700/80 text-white hover:bg-zinc-600" : "bg-red-500/80 text-white hover:bg-red-600"
                      )}
                    >
                      {isMyMicEnabled ? <Mic size={24} /> : <MicOff size={24} />}
                    </button>
                    <button
                      onClick={endCall}
                      className="p-5 bg-red-600 rounded-full text-white hover:bg-red-700 shadow-xl shadow-red-600/30"
                    >
                      <Phone size={32} className="rotate-[135deg]" />
                    </button>
                    <button
                      onClick={toggleVideo}
                      className={cn(
                        "p-4 backdrop-blur rounded-full transition-colors",
                        isMyVideoEnabled ? "bg-zinc-700/80 text-white hover:bg-zinc-600" : "bg-red-500/80 text-white hover:bg-red-600"
                      )}
                    >
                      {isMyVideoEnabled ? <Video size={24} /> : <VideoOff size={24} />}
                    </button>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;

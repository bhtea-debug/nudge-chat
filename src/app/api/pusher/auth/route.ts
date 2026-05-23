import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { pusherServer } from '@/lib/pusher';
import { db } from '@/lib/db';

// Channel naming contract for authorization checks:
//   private-user-<userId>            → only userId themselves
//   presence-channel-<channelId>     → only members of that channel
//   presence-online                  → any authenticated user (global presence)
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await req.formData();
    const socketId = formData.get('socket_id') as string;
    const channel = formData.get('channel_name') as string;

    if (!socketId || !channel) {
      return NextResponse.json({ error: 'Missing socket_id or channel_name' }, { status: 400 });
    }

    // Authorize per channel type. Without this, any logged-in user could subscribe
    // to another user's private-user-* and snoop notifications, or join any
    // presence-channel-* they aren't a member of and stream live messages.
    if (channel.startsWith('private-user-')) {
      const targetUserId = channel.slice('private-user-'.length);
      if (targetUserId !== user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const auth = pusherServer.authorizeChannel(socketId, channel);
      return NextResponse.json(auth);
    }

    if (channel.startsWith('presence-channel-')) {
      const channelId = channel.slice('presence-channel-'.length);
      const membership = await db.execute({
        sql: 'SELECT 1 FROM chat_members WHERE channel_id = ? AND user_id = ? LIMIT 1',
        args: [channelId, user.id],
      });
      if (membership.rows.length === 0) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const presenceData = {
        user_id: user.id,
        user_info: { name: user.name, email: user.email },
      };
      const auth = pusherServer.authorizeChannel(socketId, channel, presenceData);
      return NextResponse.json(auth);
    }

    if (channel === 'presence-online') {
      const presenceData = {
        user_id: user.id,
        user_info: { name: user.name, email: user.email },
      };
      const auth = pusherServer.authorizeChannel(socketId, channel, presenceData);
      return NextResponse.json(auth);
    }

    return NextResponse.json({ error: 'Invalid channel' }, { status: 403 });
  } catch (error) {
    console.error('Pusher auth error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

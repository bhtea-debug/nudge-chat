import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { pusherServer } from '@/lib/pusher';

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

    // Presence channels need user data
    if (channel.startsWith('presence-')) {
      const presenceData = {
        user_id: user.id,
        user_info: {
          name: user.name,
          email: user.email,
          avatar_url: user.avatar_url,
        },
      };
      const auth = pusherServer.authorizeChannel(socketId, channel, presenceData);
      return NextResponse.json(auth);
    }

    // Private channels
    if (channel.startsWith('private-')) {
      const auth = pusherServer.authorizeChannel(socketId, channel);
      return NextResponse.json(auth);
    }

    return NextResponse.json({ error: 'Invalid channel' }, { status: 403 });
  } catch (error) {
    console.error('Pusher auth error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

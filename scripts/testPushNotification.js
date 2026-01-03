/**
 * Test Push Notification Script
 *
 * This script sends a test push notification to a specific user.
 *
 * Usage:
 *   node scripts/testPushNotification.js <userEmail>
 *
 * Example:
 *   node scripts/testPushNotification.js user@example.com
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../dist/models');
const { pushNotificationService } = require('../dist/services/pushNotificationService');

async function sendTestNotification(userEmail) {
  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✓ Connected to MongoDB');

    // Find user by email
    console.log(`\nLooking for user: ${userEmail}`);
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      console.error(`✗ User not found: ${userEmail}`);
      process.exit(1);
    }

    console.log(`✓ Found user: ${user.displayName || user.email} (ID: ${user._id})`);

    // Check if user has push subscriptions
    if (!user.pushSubscriptions || user.pushSubscriptions.length === 0) {
      console.error('\n✗ User has no push notification subscriptions');
      console.log('Please enable push notifications on the device first using the test button in the app.');
      process.exit(1);
    }

    console.log(`✓ User has ${user.pushSubscriptions.length} push subscription(s)`);

    // Send test notification
    console.log('\nSending test push notification...');

    const payload = {
      title: '🧪 Test Notification',
      body: 'This is a test push notification from your Kanban app!',
      icon: '/icon-192x192.png',
      badge: '/icon-192x192.png',
      data: {
        url: '/',
        type: 'test',
        timestamp: new Date().toISOString()
      },
      tag: 'test-notification',
      requireInteraction: false
    };

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < user.pushSubscriptions.length; i++) {
      const subscription = user.pushSubscriptions[i];
      console.log(`\nSending to subscription ${i + 1}/${user.pushSubscriptions.length}...`);

      try {
        const result = await pushNotificationService.sendToSubscription(subscription, payload);

        if (result.success) {
          console.log(`  ✓ Successfully sent`);
          successCount++;
        } else {
          console.log(`  ✗ Failed: ${result.error}`);
          failedCount++;
        }
      } catch (error) {
        console.log(`  ✗ Error: ${error.message}`);
        failedCount++;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total subscriptions: ${user.pushSubscriptions.length}`);
    console.log(`Successfully sent: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log('='.repeat(60));

    if (successCount > 0) {
      console.log('\n✓ Test notification sent successfully!');
      console.log('Check your device for the notification.');
    } else {
      console.log('\n✗ All notifications failed to send.');
    }

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n✓ Disconnected from MongoDB');
    process.exit(0);
  }
}

// Get user email from command line arguments
const userEmail = process.argv[2];

if (!userEmail) {
  console.error('Usage: node scripts/testPushNotification.js <userEmail>');
  console.error('Example: node scripts/testPushNotification.js user@example.com');
  process.exit(1);
}

sendTestNotification(userEmail);

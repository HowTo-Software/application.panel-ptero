<?php

namespace Pterodactyl\Notifications;

use Pterodactyl\Models\User;
use Pterodactyl\Services\Users\LocalAuthentication;
use Illuminate\Bus\Queueable;
use Illuminate\Notifications\Notification;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Notifications\Messages\MailMessage;

class AccountCreated extends Notification implements ShouldQueue
{
    use Queueable;

    /**
     * Create a new notification instance.
     */
    public function __construct(public User $user, public ?string $token = null)
    {
    }

    /**
     * Get the notification's delivery channels.
     */
    public function via(): array
    {
        return ['mail'];
    }

    /**
     * Get the mail representation of the notification.
     */
    public function toMail(): MailMessage
    {
        $message = (new MailMessage())
            ->greeting('Hello ' . $this->user->name . '!')
            ->line('You are receiving this email because an account has been created for you on ' . config('app.name') . '.')
            ->line('Username: ' . $this->user->username)
            ->line('Email: ' . $this->user->email);

        if (LocalAuthentication::allows($this->user)) {
            if (!is_null($this->token)) {
                return $message
                    ->line('Use the legacy login option to access the panel with your local password.')
                    ->action('Setup Your Account', url('/auth/password/reset/' . $this->token . '?email=' . urlencode($this->user->email)));
            }

            return $message
                ->line('Use the legacy login option and the password provided separately by your administrator.')
                ->action('Sign In', url('/auth/login/legacy'));
        }

        if (LocalAuthentication::ssoEnabled()) {
            return $message->line(
                'Sign in with the Single Sign-On button. Your sign-in details are set up separately.'
            );
        }

        return $message;
    }
}

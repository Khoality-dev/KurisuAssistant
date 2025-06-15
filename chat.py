import sounddevice as sd
from helpers.agent import Agent
from helpers.utils import slow_print



if __name__ == "__main__":
    agent = Agent()
    print("Kurisu is ready to chat!")
    while True:
        prompt = input("\033[32mUser: \033[0m")
        print("\033[31mKurisu:\033[0m", "Thinking...")
        response_generator = agent.process_and_say(prompt)
        if response_generator is None:
            print("\033[31mKurisu:\033[0m", "I'm malfunctioning. Please try again later.")

        for text_data, audio_data in response_generator:
            if audio_data is not None:
                sd.play(audio_data, samplerate=32000)
                
            en_response = text_data #response.split("|")[0].strip()
            # print in color
            slow_print("\033[F\033[K\033[31mKurisu:\033[0m " + en_response)
            sd.wait()
        